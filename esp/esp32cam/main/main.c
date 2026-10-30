#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "esp_http_server.h"
#include "esp_camera.h"
#include "board_config.h"
#include "camera_index.h"

#include "wifi_config.h"

static const char *TAG = "esp32cam";
static httpd_handle_t camera_httpd;
static httpd_handle_t stream_httpd;
static EventGroupHandle_t wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
#define STREAM_BOUNDARY "123456789000000000000987654321"
#define STREAM_CONTENT_TYPE "multipart/x-mixed-replace;boundary=" STREAM_BOUNDARY
#define STREAM_BOUNDARY_LINE "\r\n--" STREAM_BOUNDARY "\r\n"

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "Wi-Fi disconnected; reconnecting");
        xEventGroupClearBits(wifi_event_group, WIFI_CONNECTED_BIT);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static esp_err_t wifi_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    wifi_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t wifi_config = {0};
    snprintf((char *)wifi_config.sta.ssid, sizeof(wifi_config.sta.ssid), "%s", WIFI_SSID);
    snprintf((char *)wifi_config.sta.password, sizeof(wifi_config.sta.password), "%s", WIFI_PASSWORD);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.sta.pmf_cfg.capable = true;
    wifi_config.sta.pmf_cfg.required = false;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_LOGI(TAG, "Connecting to Wi-Fi SSID '%s'", WIFI_SSID);
    xEventGroupWaitBits(wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, portMAX_DELAY);
    return ESP_OK;
}

static esp_err_t index_handler(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    sensor_t *s = esp_camera_sensor_get();
    if (s && s->id.PID == OV3660_PID)
        return httpd_resp_send(req, (const char *)index_ov3660_html_gz, index_ov3660_html_gz_len);
    if (s && s->id.PID == OV5640_PID)
        return httpd_resp_send(req, (const char *)index_ov5640_html_gz, index_ov5640_html_gz_len);
    return httpd_resp_send(req, (const char *)index_ov2640_html_gz, index_ov2640_html_gz_len);
}

static esp_err_t capture_handler(httpd_req_t *req)
{
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        ESP_LOGE(TAG, "Camera capture failed");
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    esp_err_t err = httpd_resp_send(req, (const char *)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    return err;
}

static esp_err_t stream_handler(httpd_req_t *req)
{
    esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    if (res != ESP_OK) return res;
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    char part[128];

    while (true) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) {
            ESP_LOGE(TAG, "Camera capture failed");
            res = ESP_FAIL;
        } else {
            if (fb->format != PIXFORMAT_JPEG) {
                esp_camera_fb_return(fb);
                res = ESP_FAIL;
            } else {
                res = httpd_resp_send_chunk(req, STREAM_BOUNDARY_LINE, strlen(STREAM_BOUNDARY_LINE));
                if (res == ESP_OK) {
                    int n = snprintf(part, sizeof(part),
                        "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
                        (unsigned)fb->len);
                    res = httpd_resp_send_chunk(req, part, n);
                }
                if (res == ESP_OK)
                    res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
                esp_camera_fb_return(fb);
            }
        }
        if (res != ESP_OK) break;
    }
    return res;
}

static esp_err_t control_handler(httpd_req_t *req)
{
    char var[32], valstr[24];
    size_t len = httpd_req_get_url_query_len(req);
    if (!len || len > 256) return httpd_resp_send_404(req);
    char *query = malloc(len + 1);
    if (!query) return httpd_resp_send_500(req);
    esp_err_t err = httpd_req_get_url_query_str(req, query, len + 1);
    if (err == ESP_OK) err = httpd_query_key_value(query, "var", var, sizeof(var));
    if (err == ESP_OK) err = httpd_query_key_value(query, "val", valstr, sizeof(valstr));
    free(query);
    if (err != ESP_OK) return httpd_resp_send_500(req);
    int val = atoi(valstr);
    sensor_t *s = esp_camera_sensor_get();
    if (!s) return httpd_resp_send_500(req);
    int rc = -1;
    if (!strcmp(var, "framesize") && s->pixformat == PIXFORMAT_JPEG) rc = s->set_framesize(s, (framesize_t)val);
    else if (!strcmp(var, "quality")) rc = s->set_quality(s, val);
    else if (!strcmp(var, "brightness")) rc = s->set_brightness(s, val);
    else if (!strcmp(var, "contrast")) rc = s->set_contrast(s, val);
    else if (!strcmp(var, "saturation")) rc = s->set_saturation(s, val);
    else if (!strcmp(var, "hmirror")) rc = s->set_hmirror(s, val);
    else if (!strcmp(var, "vflip")) rc = s->set_vflip(s, val);
    else if (!strcmp(var, "awb")) rc = s->set_whitebal(s, val);
    else if (!strcmp(var, "agc")) rc = s->set_gain_ctrl(s, val);
    else if (!strcmp(var, "aec")) rc = s->set_exposure_ctrl(s, val);
    else if (!strcmp(var, "gainceiling")) rc = s->set_gainceiling(s, (gainceiling_t)val);
    else if (!strcmp(var, "colorbar")) rc = s->set_colorbar(s, val);
    else if (!strcmp(var, "awb_gain")) rc = s->set_awb_gain(s, val);
    else if (!strcmp(var, "agc_gain")) rc = s->set_agc_gain(s, val);
    else if (!strcmp(var, "aec_value")) rc = s->set_aec_value(s, val);
    else if (!strcmp(var, "aec2")) rc = s->set_aec2(s, val);
    else if (!strcmp(var, "dcw")) rc = s->set_dcw(s, val);
    else if (!strcmp(var, "bpc")) rc = s->set_bpc(s, val);
    else if (!strcmp(var, "wpc")) rc = s->set_wpc(s, val);
    else if (!strcmp(var, "raw_gma")) rc = s->set_raw_gma(s, val);
    else if (!strcmp(var, "lenc")) rc = s->set_lenc(s, val);
    else if (!strcmp(var, "special_effect")) rc = s->set_special_effect(s, val);
    else if (!strcmp(var, "wb_mode")) rc = s->set_wb_mode(s, val);
    else if (!strcmp(var, "ae_level")) rc = s->set_ae_level(s, val);
    if (rc < 0) return httpd_resp_send_500(req);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, NULL, 0);
}

static esp_err_t status_handler(httpd_req_t *req)
{
    sensor_t *s = esp_camera_sensor_get();
    if (!s) return httpd_resp_send_500(req);
    char json[768];
    int n = snprintf(json, sizeof(json),
        "{\"framesize\":%u,\"quality\":%u,\"brightness\":%d,\"contrast\":%d,"
        "\"saturation\":%d,\"hmirror\":%u,\"vflip\":%u,\"awb\":%u,\"awb_gain\":%u,"
        "\"agc\":%u,\"agc_gain\":%u,\"aec\":%u,\"aec2\":%u,\"aec_value\":%u,"
        "\"ae_level\":%d,\"gainceiling\":%u,\"bpc\":%u,\"wpc\":%u,\"raw_gma\":%u,"
        "\"lenc\":%u,\"dcw\":%u,\"colorbar\":%u,\"special_effect\":%u,\"wb_mode\":%u}",
        (unsigned)s->status.framesize, (unsigned)s->status.quality,
        s->status.brightness, s->status.contrast, s->status.saturation,
        (unsigned)s->status.hmirror, (unsigned)s->status.vflip,
        (unsigned)s->status.awb, (unsigned)s->status.awb_gain,
        (unsigned)s->status.agc, (unsigned)s->status.agc_gain,
        (unsigned)s->status.aec, (unsigned)s->status.aec2,
        (unsigned)s->status.aec_value, s->status.ae_level,
        (unsigned)s->status.gainceiling, (unsigned)s->status.bpc,
        (unsigned)s->status.wpc, (unsigned)s->status.raw_gma,
        (unsigned)s->status.lenc, (unsigned)s->status.dcw,
        (unsigned)s->status.colorbar, (unsigned)s->status.special_effect,
        (unsigned)s->status.wb_mode);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, json, n);
}

static void register_uri(httpd_handle_t server, const char *uri, esp_err_t (*handler)(httpd_req_t *))
{
    httpd_uri_t route = {.uri = uri, .method = HTTP_GET, .handler = handler, .user_ctx = NULL};
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &route));
}

static void start_camera_server(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 8;
    config.stack_size = 8192;
    ESP_ERROR_CHECK(httpd_start(&camera_httpd, &config));
    register_uri(camera_httpd, "/", index_handler);
    register_uri(camera_httpd, "/capture", capture_handler);
    register_uri(camera_httpd, "/status", status_handler);
    register_uri(camera_httpd, "/control", control_handler);

    config.server_port = 81;
    config.ctrl_port = 32769;
    ESP_ERROR_CHECK(httpd_start(&stream_httpd, &config));
    register_uri(stream_httpd, "/stream", stream_handler);
    ESP_LOGI(TAG, "Camera UI: http://<device-ip>/  |  Stream: http://<device-ip>:81/stream");
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(ret);
    }

    camera_config_t config = {
        .pin_pwdn = PWDN_GPIO_NUM,
        .pin_reset = RESET_GPIO_NUM,
        .pin_xclk = XCLK_GPIO_NUM,
        .pin_sccb_sda = SIOD_GPIO_NUM,
        .pin_sccb_scl = SIOC_GPIO_NUM,
        .pin_d0 = Y2_GPIO_NUM, .pin_d1 = Y3_GPIO_NUM,
        .pin_d2 = Y4_GPIO_NUM, .pin_d3 = Y5_GPIO_NUM,
        .pin_d4 = Y6_GPIO_NUM, .pin_d5 = Y7_GPIO_NUM,
        .pin_d6 = Y8_GPIO_NUM, .pin_d7 = Y9_GPIO_NUM,
        .pin_vsync = VSYNC_GPIO_NUM, .pin_href = HREF_GPIO_NUM,
        .pin_pclk = PCLK_GPIO_NUM,
        .xclk_freq_hz = 20000000,
        .ledc_timer = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,
        .pixel_format = PIXFORMAT_JPEG,
        .frame_size = FRAMESIZE_QVGA,
        .jpeg_quality = 12,
        .fb_count = 2,
        .grab_mode = CAMERA_GRAB_LATEST,
        .fb_location = CAMERA_FB_IN_PSRAM,
    };
    if (!esp_psram_is_initialized()) {
        config.frame_size = FRAMESIZE_VGA;
        config.fb_count = 1;
        config.fb_location = CAMERA_FB_IN_DRAM;
    }
    ESP_ERROR_CHECK(esp_camera_init(&config));

    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor && sensor->id.PID == OV3660_PID) {
        sensor->set_vflip(sensor, 1);
        sensor->set_brightness(sensor, 1);
        sensor->set_saturation(sensor, -2);
    }

    ESP_ERROR_CHECK(wifi_start());
    start_camera_server();
}
