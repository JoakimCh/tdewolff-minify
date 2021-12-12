
# Benchmark (Node API vs Native CLI)

### Description

A benchmark of how the Node.js API (using the minify-biniary's stdin/stdout) to minify a whole folder compares to the minify CLI natively doing the same thing. This gives us an indication of the performance overhead of the Node.js API.

### How to use

To run all tests (against native):
```node benchmark_versus_native```

To run only a stdin / stdout performance test where the files are cached and no files are written:
```node benchmark_versus_native x```
