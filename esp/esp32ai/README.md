# ESP32 AI Hand Classifier

This is a native ESP-IDF project that captures grayscale images with an ESP32-CAM and runs the embedded hand-recognition model using TensorFlow Lite Micro. The camera frame's resolution is read from each captured frame. Preprocessing center-crops it to the model input's aspect ratio and downsamples it to `kInputWidth` x `kInputHeight` using pixel averages.

The target dimensions are configured in `main/esp32ai.cc`. They must match the model input dimensions; if you change them, update `inputWidth` and `inputHeight` in `create_model.py` and regenerate the model as well. The defaults (320x240) match the checked-in model.

## 1. Requirements
- ESP-IDF **v6.1** installed and exported in the shell.
- AI-Thinker ESP32-CAM with PSRAM and OV2640.
- 5 V supply capable of providing adequate current.
- USB-to-serial connection for flashing and viewing logs.

The camera and TensorFlow Lite Micro components are managed by the ESP Component Manager (`main/idf_component.yml`).

## 2. Build and flash

```sh
idf.py reconfigure
idf.py build
idf.py -p PORT flash monitor
```

Replace `PORT` with the serial port, e.g. `COM4` on Windows or `/dev/ttyUSB0` on Linux.

## 3. View inference results
After startup, the device captures camera frames and runs the model continuously. The serial monitor prints scores for all labels.
