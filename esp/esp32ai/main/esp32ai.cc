#include "freertos/FreeRTOS.h"
#include "esp_camera.h"
#include "esp_err.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_heap_caps.h"
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
const int labels = 8;  // Number of output labels in the model

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
    static tflite::MicroInterpreter interp(model, resolver, arena, kArena);
    if (interp.AllocateTensors() != kTfLiteOk) {
        ESP_LOGE(TAG, "Tensor allocation failed; model needs more than %u bytes of arena", (unsigned)kArena);
        return;
    }

    // Get pointers to the model's input and output tensors
    TfLiteTensor *in  = interp.input(0);
    TfLiteTensor *out = interp.output(0);

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
        if (fb->format != PIXFORMAT_GRAYSCALE || fb->width != kInputWidth || fb->height != kInputHeight || fb->len != kInputSize) {
            ESP_LOGE(TAG, "Unexpected Frame: %u Bytes, %ux%u, format %d", static_cast<unsigned>(fb->len), 
                fb->width,
                fb->height,
                fb->format);
            esp_camera_fb_return(fb);
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        // parse image to tf interpreter
        for (int i = 0; i < kInputSize; i++)
            in->data.int8[i] = (int8_t)(fb->buf[i] - 128);
        esp_camera_fb_return(fb);     
        interp.Invoke();

        // print label values
        for (int i = 0; i < labels; i++) {
            float value = (out->data.int8[i] - out->params.zero_point) * out->params.scale;
            ESP_LOGI(TAG, "Label %d: %.3f", i, value);
        }
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
        .fb_count = 2, // Test fb_count = 1 because of Log Message "FB-Size: 44160 != 76800"
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