# Create a model with random weights and convert it to TFLite INT8. 
# This is used to test the inference engine on ESP32.
import numpy as np
import tensorflow as tf
from tensorflow.keras import layers as L

inputWidth = 320
inputHeight = 240
labels = 3

def block(x, f, s):
    x = L.DepthwiseConv2D(3, strides=s, padding="same", use_bias=False)(x)
    x = L.BatchNormalization()(x); x = L.ReLU(6.)(x)
    x = L.Conv2D(f, 1, use_bias=False)(x)
    x = L.BatchNormalization()(x); return L.ReLU(6.)(x)

inp = L.Input((inputWidth, inputHeight, 1))
x = L.Conv2D(labels, 3, strides=2, padding="same", use_bias=False)(inp)
x = L.BatchNormalization()(x); x = L.ReLU(6.)(x)
for f, s in [(16,1),(32,2),(32,1),(64,2),(64,1),(96,2)]:
    x = block(x, f, s)
x = L.GlobalAveragePooling2D()(x)
out = L.Dense(labels, activation="sigmoid")(L.Dense(32, activation="relu")(x))
model = tf.keras.Model(inp, out)
model.compile("adam", "mse")


def rep():
    # Calibration data is only used to determine INT8 ranges; it does not train the model.
    rng = np.random.default_rng(0)
    for _ in range(100):
        image = rng.integers(0, 256, size=(1, inputWidth, inputHeight, 1), dtype=np.uint8)
        yield [image.astype(np.float32)]

conv = tf.lite.TFLiteConverter.from_keras_model(model)
conv.optimizations = [tf.lite.Optimize.DEFAULT]
conv.representative_dataset = rep
conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
conv.inference_input_type = tf.int8
conv.inference_output_type = tf.int8
open("hand.tflite", "wb").write(conv.convert())