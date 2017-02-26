# unzip-stream

Streaming cross-platform unzip tool written in node.js.

This package is based on [unzip](https://github.com/EvanOxfeld/node-unzip) and provides simple APIs similar to [node-tar](https://github.com/isaacs/node-tar) for parsing and extracting zip files.
There are no added compiled dependencies - inflation is handled by node.js's built in zlib support.

Please note that the zip file format isn't really meant to be processed by streaming, though this library should succeed in most cases, if you do have complete zip file available, you should consider using other libraries which read zip files from the end - as originally intended.

## Installation

```bash
$ npm install unzip-stream
```

## Quick Examples

### Parse zip file contents

Process each zip file entry or pipe entries to another stream.

__Important__: If you do not intend to consume an entry stream's raw data, call autodrain() to dispose of the entry's
contents. Otherwise you risk running out of memory.

```javascript
fs.createReadStream('path/to/archive.zip')
  .pipe(unzip.Parse())
  .on('entry', function (entry) {
    var filePath = entry.path;
    var type = entry.type; // 'Directory' or 'File'
    var size = entry.size;
    if (filePath === "this IS the file I'm looking for") {
      entry.pipe(fs.createWriteStream('output/path'));
    } else {
      entry.autodrain();
    }
  });
```

### Parse zip by piping entries downstream

If you `pipe` from unzipper the downstream components will receive each `entry` for further processing.   This allows for clean pipelines transforming zipfiles into unzipped data.

Example using `stream.Transform`:

```js
fs.createReadStream('path/to/archive.zip')
  .pipe(unzipper.Parse())
  .pipe(stream.Transform({
    objectMode: true,
    transform: function(entry,e,cb) {
      var filePath = entry.path;
      var type = entry.type; // 'Directory' or 'File'
      var size = entry.size;
      if (filePath === "this IS the file I'm looking for") {
        entry.pipe(fs.createWriteStream('output/path'))
          .on('finish',cb);
      } else {
        entry.autodrain();
        cb();
      }
    }
  }
  }));
```

### Extract to a directory
```javascript
fs.createReadStream('path/to/archive.zip').pipe(unzip.Extract({ path: 'output/path' }));
```

Extract emits the 'close' event once the zip's contents have been fully extracted to disk.

## License

(The MIT License)

Copyright (c) 2017 Michal Hruby
Copyright (c) 2012 - 2013 Near Infinity Corporation

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

