# ESP32-CAM Web Server — native ESP-IDF 6.1

This is a native ESP-IDF C project rebuilt from the uploaded Arduino CameraWebServer sources. It targets the **AI-Thinker ESP32-CAM with OV2640** and keeps the original compressed CameraWebServer browser UI asset. The HTTP server provides `/`, `/capture`, `/status`, `/control`; MJPEG streaming is served on port 81 at `/stream`.

## 1. Requirements
- ESP-IDF **v6.1** installed and exported in the shell.
- AI-Thinker ESP32-CAM with PSRAM and OV2640.
- 5 V supply capable of providing adequate current.
- Wi-Fi network credentials.

The camera driver is managed by the ESP Component Manager (`espressif/esp32-camera` in `main/idf_component.yml`).

## 2. Configure Wi-Fi
Create a file `wifi_config.h` in the folder main and enter your WIFI credentials. Refer to the file `wifi_config.h.example`

## 3. Build and flash

```sh
idf.py reconfigure
idf.py build
idf.py -p PORT flash monitor
```

Replace `PORT` with the serial port, e.g. `COM4` on Windows or `/dev/ttyUSB0` on Linux. For the usual ESP32-CAM flashing procedure, hold GPIO0 low while resetting to enter download mode; release GPIO0 and reset again after flashing.

## 4. Open the camera
Watch the serial monitor for `Got IP: ...`, then browse to:

- `http://DEVICE_IP/` — camera control UI
- `http://DEVICE_IP/capture` — still JPEG
- `http://DEVICE_IP:81/stream` — MJPEG stream
- `http://DEVICE_IP/status` — supported sensor status fields

The camera and stream endpoints are on the local network. Do not expose them directly to the public internet without adding authentication and transport security.