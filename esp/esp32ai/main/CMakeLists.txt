idf_component_register(SRCS "esp32ai.cc" "model.cc"
                    INCLUDE_DIRS "."
                    EMBED_TXTFILES "../model/output/labels.txt")
