# ESP32-CAM Web Server

This is a native ESP-IDF C project rebuilt from the Arduino CameraWebServer example project. The code is simplified to an HTTP stream from the camera. 

## 1. Requirements
- ESP-IDF **v6.1** installed and exported in the shell.
- AI-Thinker ESP32-CAM with PSRAM and OV2640.
- 5 V supply capable of providing adequate current.
- Wi-Fi network credentials.

The camera driver is managed by the ESP Component Manager (`espressif/esp32-camera` in `main/idf_component.yml`).

## 2. Configure Wi-Fi
Create a file `wifi_config.h` in the folder main and enter your WIFI credentials. Refer to the file `wifi_config.h.example`
The actual `wifi_config.h` is ignored by Git and should not be committed. The GitHub Actions build copies the example file to `wifi_config.h`; placeholder credentials are sufficient because the workflow only compiles the project.

## 3. Build and flash

```sh
idf.py reconfigure
idf.py build
idf.py -p PORT flash monitor
```

Replace `PORT` with the serial port, e.g. `COM4` on Windows or `/dev/ttyUSB0` on Linux. 

## 4. Open the camera
Watch the serial monitor for `Got IP: ...`, then browse to: `http://DEVICE_IP/`