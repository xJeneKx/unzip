var Transform = require('stream').Transform;
var util = require('util');
var UnzipStream = require('./unzip-stream');

function ParserStream() {
    if (!(this instanceof ParserStream)) {
        return new ParserStream();
    }

    Transform.call(this, { readableObjectMode: true });

    this.unzipStream = new UnzipStream();
    this.finishCb = null;

    var self = this;
    this.unzipStream.on("entry", function(entry) {
        self.emit("entry", entry);
        self.push(entry);
    });
    this.unzipStream.on("end", function() {
        if (self.finishCb) self.finishCb();
    });
    this.unzipStream.on("error", function(error) {
        self.emit("error", error);
    });
}

util.inherits(ParserStream, Transform);

ParserStream.prototype._transform = function (chunk, encoding, cb) {
    this.unzipStream.write(chunk, encoding, cb);
}

ParserStream.prototype._flush = function (cb) {
    this.finishCb = cb;
    this.unzipStream.end();
}

module.exports = ParserStream;