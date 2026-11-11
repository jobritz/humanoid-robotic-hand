# ESP32 AI Hand Classifier

This is a native ESP-IDF project that captures grayscale images with an ESP32-CAM and runs the embedded hand-recognition model using TensorFlow Lite Micro. The model expects an image with the sizes `kInputWidth` x `kInputheight` and reports  the values of all labels.

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