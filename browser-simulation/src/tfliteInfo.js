// Liest und korrigiert .tflite-Dateien (FlatBuffer nach tensorflow/lite/schema/schema.fbs):
// - readTfliteInfo: Ein- und Ausgaben mit Form, Datentyp und Quantisierung sowie die verwendeten Operatoren.
//   LiteRT.js gibt scale/zero_point nicht heraus, ohne sie lassen sich INT8-Modelle aber nicht wie auf dem ESP32
//   befüllen und auswerten.
// - withStaticShapes: legt dynamische Dimensionen (z. B. Batch -1 aus Keras) auf die feste Form fest – wie TFLM auf
//   dem ESP32, das nur Tensor.shape verwendet. LiteRT.js lehnt Eingaben sonst ab.

/** TensorType aus schema.fbs (Index = Wert), als Namen wie bei LiteRT.js. */
const TENSOR_TYPES = ['float32', 'float16', 'int32', 'uint8', 'int64', 'string', 'bool', 'int16', 'complex64', 'int8'];

/** Häufige BuiltinOperator-Werte aus schema.fbs; die Namen entsprechen den Add…()-Aufrufen im MicroMutableOpResolver. */
const OPERATORS = {
  0: 'ADD', 1: 'AVERAGE_POOL_2D', 2: 'CONCATENATION', 3: 'CONV_2D', 4: 'DEPTHWISE_CONV_2D', 6: 'DEQUANTIZE',
  9: 'FULLY_CONNECTED', 14: 'LOGISTIC', 17: 'MAX_POOL_2D', 18: 'MUL', 19: 'RELU', 21: 'RELU6', 22: 'RESHAPE',
  25: 'SOFTMAX', 28: 'TANH', 34: 'PAD', 40: 'MEAN', 41: 'SUB', 43: 'SQUEEZE', 114: 'QUANTIZE', 117: 'HARD_SWISH',
};

/** Minimaler FlatBuffer-Leser: Tabellen verweisen auf eine vtable mit den Feld-Offsets, Verweise sind relativ (uint32). */
function flatbuffer(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'TFL3') {
    throw new Error('Keine gültige .tflite-Datei (Kennung "TFL3" fehlt).');
  }
  const deref = (pos) => pos + view.getUint32(pos, true);
  /** Position von Feld `i` der Tabelle, 0 = nicht gesetzt. */
  const field = (table, i) => {
    const vtable = table - view.getInt32(table, true);
    const offset = 4 + 2 * i < view.getUint16(vtable, true) ? view.getUint16(vtable + 4 + 2 * i, true) : 0;
    return offset ? table + offset : 0;
  };
  /** Positionen der Elemente eines Vektor-Feldes (Elementgröße `size` in Byte). */
  const items = (table, i, size) => {
    const pos = field(table, i);
    if (!pos) return [];
    const start = deref(pos);
    return Array.from({ length: view.getUint32(start, true) }, (_, k) => start + 4 + k * size);
  };
  const fb = {
    view,
    field,
    items,
    deref,
    tables: (table, i) => items(table, i, 4).map(deref),
    ints: (table, i) => items(table, i, 4).map((p) => view.getInt32(p, true)),
    string: (table, i) => {
      const pos = field(table, i);
      if (!pos) return '';
      const start = deref(pos);
      return new TextDecoder().decode(bytes.subarray(start + 4, start + 4 + view.getUint32(start, true)));
    },
  };
  const [subgraph] = fb.tables(deref(0), 2); // Model.subgraphs – ausgeführt wird der erste Teilgraph
  if (!subgraph) throw new Error('Das Modell enthält keinen Teilgraphen.');
  return { ...fb, model: deref(0), subgraph, tensors: fb.tables(subgraph, 0) }; // SubGraph.tensors
}

/**
 * @param {Uint8Array} bytes Inhalt der .tflite-Datei
 * @returns {{inputs: TensorInfo[], outputs: TensorInfo[], operators: string[]}}
 *   TensorInfo = { name, shape: number[], dtype, scale, zeroPoint } – scale = 0, wenn der Tensor nicht quantisiert ist.
 */
export function readTfliteInfo(bytes) {
  const { view, field, items, deref, tables, ints, string, model, subgraph, tensors } = flatbuffer(bytes);

  const tensorInfo = (index) => {
    const t = tensors[index];
    const typePos = field(t, 1); // Tensor.type (Standard 0 = float32)
    const quant = field(t, 4) && deref(field(t, 4)); // Tensor.quantization
    const scale = quant ? items(quant, 2, 4).map((p) => view.getFloat32(p, true)) : [];
    const zeroPoint = quant ? items(quant, 3, 8).map((p) => Number(view.getBigInt64(p, true))) : [];
    return {
      name: string(t, 3),
      shape: ints(t, 0),
      dtype: TENSOR_TYPES[typePos ? view.getInt8(typePos) : 0] ?? 'unbekannt',
      scale: scale[0] ?? 0, // je Tensor eine Quantisierung (bei Ein-/Ausgaben üblich)
      zeroPoint: zeroPoint[0] ?? 0,
    };
  };

  // OperatorCode: builtin_code (Feld 3) ersetzt deprecated_builtin_code (Feld 0) ab Wert 127.
  const operators = tables(model, 1).map((code) => {
    const custom = string(code, 1);
    if (custom) return `CUSTOM:${custom}`;
    const oldPos = field(code, 0);
    const newPos = field(code, 3);
    const op = Math.max(oldPos ? view.getInt8(oldPos) : 0, newPos ? view.getInt32(newPos, true) : 0);
    return OPERATORS[op] ?? `BUILTIN_${op}`;
  });

  return {
    inputs: ints(subgraph, 1).map(tensorInfo), // SubGraph.inputs
    outputs: ints(subgraph, 2).map(tensorInfo), // SubGraph.outputs
    operators: [...new Set(operators)],
  };
}

/** Kopie der Datei, in der Tensor.shape_signature (dynamisch, z. B. [-1, 60, 80, 1]) gleich Tensor.shape ist. */
export function withStaticShapes(bytes) {
  const copy = bytes.slice();
  const { view, items, ints, tensors } = flatbuffer(copy);
  for (const t of tensors) {
    const shape = ints(t, 0);
    items(t, 7, 4).forEach((pos, k) => view.setInt32(pos, shape[k] ?? 1, true)); // Feld 7: shape_signature
  }
  return copy;
}
