#include "freertos/FreeRTOS.h"
#include "esp_camera.h"
#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_heap_caps.h"
#include <stdint.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
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

constexpr size_t kArena = 48 * 1024; // 48 KB Tensor Arena in PSRAM
constexpr int kInputWidth = 64;
constexpr int kInputHeight = 48;
constexpr size_t kInputSize = kInputWidth * kInputHeight;

// load label from labels.txt (embedded in the binary by the linker)
extern const char labels_txt_start[] asm("_binary_labels_txt_start");
extern const char labels_txt_end[] asm("_binary_labels_txt_end");

static const char *label_for_output(size_t index)
{
    size_t line_index = 0;
    const char *line = labels_txt_start;

    while (line < labels_txt_end) {
        const char *line_end = line;
        while (line_end < labels_txt_end &&
               *line_end != '\r' && *line_end != '\n') {
            line_end++;
        }

        if (line_index == index) {
            const char *equals = line;
            while (equals < line_end && *equals != '=') {
                equals++;
            }
            if (equals < line_end) {
                equals++;
                while (equals < line_end &&
                       (*equals == ' ' || *equals == '\t')) {
                    equals++;
                }
                if (equals < line_end) {
                    static char label[64];
                    const size_t length =
                        static_cast<size_t>(line_end - equals);
                    const size_t copy_length =
                        length < sizeof(label) - 1 ? length : sizeof(label) - 1;
                    memcpy(label, equals, copy_length);
                    label[copy_length] = '\0';
                    return label;
                }
            }
            return "Unknown";
        }

        line_index++;
        line = line_end;
        while (line < labels_txt_end &&
               (*line == '\r' || *line == '\n')) {
            line++;
        }
    }

    return "Unknown";
}

// Log the tensor's name, type, shape, number of bytes, scale, and zero point.
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

    ESP_LOGI(TAG, "%s: type=%d shape=[%s] bytes=%u scale=%g zero_point=%d",
             name, static_cast<int>(tensor->type), shape,
             static_cast<unsigned>(tensor->bytes), tensor->params.scale,
             tensor->params.zero_point);
}

// Preprocess the camera frame to fit the model's input tensor.
static bool preprocess_frame(const camera_fb_t *frame, TfLiteTensor *input)
{
    if (frame->format != PIXFORMAT_GRAYSCALE || frame->buf == nullptr ||
        frame->width == 0 || frame->height == 0 ||
        frame->len != static_cast<size_t>(frame->width) * frame->height) {
        return false;
    }

    int cropWidth = frame->width;
    int cropHeight = frame->height;
    if (cropWidth * kInputHeight > cropHeight * kInputWidth) {
        cropWidth = cropHeight * kInputWidth / kInputHeight;
    } else {
        cropHeight = cropWidth * kInputHeight / kInputWidth;
    }

    if (cropWidth < kInputWidth || cropHeight < kInputHeight) {
        return false;
    }

    const int cropX = (frame->width - cropWidth) / 2;
    const int cropY = (frame->height - cropHeight) / 2;
    for (int y = 0; y < kInputHeight; y++) {
        const int sourceYStart = cropY + y * cropHeight / kInputHeight;
        const int sourceYEnd = cropY + (y + 1) * cropHeight / kInputHeight;
        for (int x = 0; x < kInputWidth; x++) {
            const int sourceXStart = cropX + x * cropWidth / kInputWidth;
            const int sourceXEnd = cropX + (x + 1) * cropWidth / kInputWidth;
            uint32_t sum = 0;
            uint32_t pixelCount = 0;
            for (int sourceY = sourceYStart; sourceY < sourceYEnd; sourceY++) {
                const uint8_t *row = frame->buf + sourceY * frame->width;
                for (int sourceX = sourceXStart; sourceX < sourceXEnd; sourceX++) {
                    sum += row[sourceX];
                    pixelCount++;
                }
            }

            const int8_t pixel = static_cast<int8_t>(
                static_cast<int>(sum / pixelCount) - 128);
            input->data.int8[y * kInputWidth + x] = pixel;
        }
    }
    return true;
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

    // log the tensor arena usage
    const size_t used = interpreter.arena_used_bytes();
    ESP_LOGI(TAG, "Tensor Arena: %u Bytes (%u%% usage)", 
        static_cast<unsigned>(used), 
        static_cast<unsigned>((used * 100) / kArena));

    // Get pointers to the model's input and output tensors
    TfLiteTensor *in  = interpreter.input(0);
    TfLiteTensor *out = interpreter.output(0);

    // check that the input tensor has the expected type and shape
    if (in == nullptr || out == nullptr || in->type != kTfLiteInt8 ||
        in->dims == nullptr || in->dims->size != 4 ||
        in->dims->data[0] != 1 || in->dims->data[1] != kInputHeight ||
        in->dims->data[2] != kInputWidth || in->dims->data[3] != 1 ||
        in->bytes != kInputSize) {
        ESP_LOGE(TAG, "Model input must be int8 with shape [1, %d, %d, 1]", kInputHeight, kInputWidth);
        return;
    }

    // log the input and output tensors
    log_tensor("Input tensor", in);
    log_tensor("Output tensor", out);

    // run the model
    while (true) {
        // Get the current image of the camera
        camera_fb_t *fb = esp_camera_fb_get();

        // check camera image integrity
        if (fb == nullptr) {
            ESP_LOGW(TAG, "No camera frame received");
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (!preprocess_frame(fb, in)) {
            ESP_LOGE(TAG, "Cannot preprocess frame: %u Bytes, %ux%u, format %d",
                     static_cast<unsigned>(fb->len), fb->width, fb->height,
                     fb->format);
            esp_camera_fb_return(fb);
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        esp_camera_fb_return(fb);

        // Run the model on this input and make sure it succeeds.
        if (kTfLiteOk != interpreter.Invoke()) {
            ESP_LOGE(TAG, "Invoke failed.");
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        // Dequantize the int8 output into a probability-like value.
        for (size_t i = 0; i < out->bytes / sizeof(int8_t); i++) {
            const float probability =
                (static_cast<int32_t>(out->data.int8[i]) - out->params.zero_point) *
                out->params.scale;
            printf("%s: %.6f\n", label_for_output(i), probability);
        }
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