#include "freertos/FreeRTOS.h"
#include "esp_camera.h"
#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include <cmath>
#include <stdint.h>
#include <stdio.h>
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/schema/schema_generated.h"

#include "model.h"

#define CAM_PIN_PWDN    32
#define CAM_PIN_RESET   -1
#define CAM_PIN_XCLK     0
#define CAM_PIN_SIOD    26
#define CAM_PIN_SIOC    27
#define CAM_PIN_D7      35
#define CAM_PIN_D6      34
#define CAM_PIN_D5      39
#define CAM_PIN_D4      36
#define CAM_PIN_D3      21
#define CAM_PIN_D2      19
#define CAM_PIN_D1      18
#define CAM_PIN_D0       5
#define CAM_PIN_VSYNC   25
#define CAM_PIN_HREF    23
#define CAM_PIN_PCLK    22

static const char *TAG = "esp32ai";

constexpr size_t kArena = 512 * 1024; // 512 KB Tensor Arena in PSRAM
const int kInputWidth = 320;
const int kInputHeight = 240;
constexpr int kInputSize = kInputWidth * kInputHeight; // Input size of the model

constexpr uint32_t kTimingReportInterval = 50;

struct StageStats {
    uint64_t total_us = 0;
    uint64_t max_us = 0;
    uint32_t samples = 0;
};

static void record_stage(StageStats &stats, uint64_t duration_us)
{
    stats.total_us += duration_us;
    if (duration_us > stats.max_us) {
        stats.max_us = duration_us;
    }
    stats.samples++;
}

static void log_stage(const char *name, const StageStats &stats)
{
    if (stats.samples == 0) {
        ESP_LOGI(TAG, "%s: no samples", name);
        return;
    }

    ESP_LOGI(TAG, "%s: avg=%llu us, max=%llu us, n=%u",
             name,
             static_cast<unsigned long long>(stats.total_us / stats.samples),
             static_cast<unsigned long long>(stats.max_us),
             static_cast<unsigned>(stats.samples));
}

static void log_tensor(const char *name, const TfLiteTensor *tensor)
{
    char shape[64] = {};
    size_t used = 0;
    if (tensor->dims != nullptr) {
        for (int i = 0; i < tensor->dims->size; i++) {
            const int written = snprintf(shape + used, sizeof(shape) - used,
                                         "%s%d", i == 0 ? "" : ",",
                                         tensor->dims->data[i]);
            if (written < 0 || static_cast<size_t>(written) >= sizeof(shape) - used) {
                break;
            }
            used += static_cast<size_t>(written);
        }
    }

    ESP_LOGI(TAG, "%s: type=%d shape=[%s] bytes=%u scale=%.9g zero_point=%d",
             name, static_cast<int>(tensor->type), shape,
             static_cast<unsigned>(tensor->bytes), tensor->params.scale,
             tensor->params.zero_point);
}

static int8_t quantize_pixel(uint8_t pixel, const TfLiteTensor *input)
{
    const float quantized = static_cast<float>(pixel) / input->params.scale +
                            input->params.zero_point;
    if (quantized <= -128.0f) {
        return INT8_MIN;
    }
    if (quantized >= 127.0f) {
        return INT8_MAX;
    }
    return static_cast<int8_t>(std::lround(quantized));
}

static void run_model(void)
{
    // load the model from model.h (hand_tflite is a C array containing the model data)
    const tflite::Model *model = tflite::GetModel(hand_tflite);

    // create a resolver with maximum 6 operators.
    static tflite::MicroMutableOpResolver<6> resolver;

    // The Add-functions below add the various Builtin operators to the MicroMutableOpResolver object.
    resolver.AddConv2D();
    resolver.AddDepthwiseConv2D();
    resolver.AddMean();
    resolver.AddFullyConnected();
    resolver.AddLogistic();
    resolver.AddReshape();

    // create a tensor arena in PSRAM to hold the model's tensors
    uint8_t *arena = (uint8_t *)heap_caps_malloc(kArena, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (arena == nullptr) {
        ESP_LOGE(TAG, "Failed to allocate %u-byte tensor arena in PSRAM", (unsigned)kArena);
        return;
    }

    // create a MicroInterpreter object to run the model
    static tflite::MicroInterpreter interpreter(model, resolver, arena, kArena);
    if (interpreter.AllocateTensors() != kTfLiteOk) {
        ESP_LOGE(TAG, "Tensor allocation failed; model needs more than %u bytes of arena", (unsigned)kArena);
        return;
    }

    // Get pointers to the model's input and output tensors
    TfLiteTensor *in  = interpreter.input(0);
    TfLiteTensor *out = interpreter.output(0);
    if (in == nullptr || out == nullptr) {
        ESP_LOGE(TAG, "Model input or output tensor is unavailable");
        return;
    }
    log_tensor("Input tensor", in);
    log_tensor("Output tensor", out);
    if (in->type != kTfLiteInt8 || out->type != kTfLiteInt8 ||
        in->bytes != kInputSize || !(in->params.scale > 0.0f) ||
        !std::isfinite(in->params.scale) || !(out->params.scale > 0.0f) ||
        !std::isfinite(out->params.scale)) {
        ESP_LOGE(TAG, "Expected int8 input of %d bytes and int8 output with valid quantization", kInputSize);
        return;
    }

    uint32_t attempts = 0;
    uint32_t valid_frames = 0;
    StageStats camera_stats;
    StageStats validation_stats;
    StageStats preprocessing_stats;
    StageStats inference_stats;
    StageStats output_stats;

    const auto report_timings = [&]() {
        if (attempts < kTimingReportInterval) {
            return;
        }
        ESP_LOGI(TAG, "Timing window: %u attempts, %u valid frames",
                 static_cast<unsigned>(attempts),
                 static_cast<unsigned>(valid_frames));
        log_stage("Camera wait", camera_stats);
        log_stage("Frame validation", validation_stats);
        log_stage("Input quantization/copy", preprocessing_stats);
        log_stage("Inference", inference_stats);
        log_stage("Output serial", output_stats);
        attempts = 0;
        valid_frames = 0;
        camera_stats = {};
        validation_stats = {};
        preprocessing_stats = {};
        inference_stats = {};
        output_stats = {};
    };

    // run the model
    while (true) {
        attempts++;

        // Get the current image of the camera
        const int64_t camera_start_us = esp_timer_get_time();
        camera_fb_t *fb = esp_camera_fb_get();
        record_stage(camera_stats, static_cast<uint64_t>(esp_timer_get_time() - camera_start_us));

        // check camera image integrity
        if (fb == nullptr) {
            ESP_LOGW(TAG, "No camera frame received");
            report_timings();
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        const int64_t validation_start_us = esp_timer_get_time();
        const bool valid_frame = fb->format == PIXFORMAT_GRAYSCALE &&
                                 fb->width == kInputWidth &&
                                 fb->height == kInputHeight &&
                                 fb->len == kInputSize;
        record_stage(validation_stats,
                     static_cast<uint64_t>(esp_timer_get_time() - validation_start_us));
        if (!valid_frame) {
            ESP_LOGE(TAG, "Unexpected Frame: %u Bytes, %ux%u, format %d", static_cast<unsigned>(fb->len), 
                fb->width,
                fb->height,
                fb->format);
            esp_camera_fb_return(fb);
            report_timings();
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        // Quantize the grayscale pixels using the model's input tensor parameters.
        const int64_t preprocessing_start_us = esp_timer_get_time();
        if (in->params.scale == 1.0f && in->params.zero_point == -128) {
            for (int i = 0; i < kInputSize; i++) {
                in->data.int8[i] = static_cast<int8_t>(fb->buf[i] ^ 0x80);
            }
        } else {
            for (int i = 0; i < kInputSize; i++) {
                in->data.int8[i] = quantize_pixel(fb->buf[i], in);
            }
        }
        esp_camera_fb_return(fb);
        record_stage(preprocessing_stats,
                     static_cast<uint64_t>(esp_timer_get_time() - preprocessing_start_us));

        // Run the model on this input and make sure it succeeds.
        const int64_t inference_start_us = esp_timer_get_time();
        if (kTfLiteOk != interpreter.Invoke()) {
            record_stage(inference_stats,
                         static_cast<uint64_t>(esp_timer_get_time() - inference_start_us));
            ESP_LOGE(TAG, "Invoke failed.");
            report_timings();
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        record_stage(inference_stats,
                     static_cast<uint64_t>(esp_timer_get_time() - inference_start_us));

        // Dequantize the int8 output into the sigmoid probability range.
        const int64_t output_start_us = esp_timer_get_time();
        for (size_t i = 0; i < out->bytes / sizeof(int8_t); i++) {
            const float probability =
                (static_cast<int32_t>(out->data.int8[i]) - out->params.zero_point) *
                out->params.scale;
            printf("Output[%u]: %.6f\n", static_cast<unsigned>(i), probability);
        }
        record_stage(output_stats,
                     static_cast<uint64_t>(esp_timer_get_time() - output_start_us));
        valid_frames++;
        report_timings();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

extern "C" void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(err);
    }

    // init camera
    camera_config_t camera_config = {
        .pin_pwdn = CAM_PIN_PWDN,
        .pin_reset = CAM_PIN_RESET,
        .pin_xclk = CAM_PIN_XCLK,
        .pin_sccb_sda = CAM_PIN_SIOD,
        .pin_sccb_scl = CAM_PIN_SIOC,
        .pin_d7 = CAM_PIN_D7,
        .pin_d6 = CAM_PIN_D6,
        .pin_d5 = CAM_PIN_D5,
        .pin_d4 = CAM_PIN_D4,
        .pin_d3 = CAM_PIN_D3,
        .pin_d2 = CAM_PIN_D2,
        .pin_d1 = CAM_PIN_D1,
        .pin_d0 = CAM_PIN_D0,
        .pin_vsync = CAM_PIN_VSYNC,
        .pin_href = CAM_PIN_HREF,
        .pin_pclk = CAM_PIN_PCLK,

        .xclk_freq_hz = 20000000,
        .ledc_timer = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,

        .pixel_format = PIXFORMAT_GRAYSCALE,
        .frame_size = FRAMESIZE_QVGA,
        .jpeg_quality = 63,
        .fb_count = 1, // Test fb_count = 1 because of Log Message "FB-Size: 44160 != 76800"
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST, // Test CAMERA_GRAB_WHEN_EMPTY because of Log Message "FB-Size: 44160 != 76800"
#if CONFIG_CAMERA_CONVERTER_ENABLED
        .conv_mode = CONV_DISABLE, // Conversion of Image encoding: RGB565_TO_YUV422, YUV422_TO_RGB565, YUV422_TO_YUV420
#endif
        .sccb_i2c_port = 0,
        .jpeg_buffer_size = 0
    };
    ESP_ERROR_CHECK(esp_camera_init(&camera_config));

    // run model
    run_model();
}