var binary = require('binary');
var stream = require('stream');
var util = require('util');
var zlib = require('zlib');
var MatcherStream = require('./matcher-stream');
var Entry = require('./entry');

const states = {
    START: 0,
    LOCAL_FILE_HEADER: 1,
    LOCAL_FILE_HEADER_SUFFIX: 2,
    FILE_DATA: 3,
    FILE_DATA_END: 4,
    DATA_DESCRIPTOR: 5,
    CENTRAL_DIRECTORY_FILE_HEADER: 6,
    CENTRAL_DIRECTORY_FILE_HEADER_SUFFIX: 7,
    CENTRAL_DIRECTORY_END: 8,
    CENTRAL_DIRECTORY_END_COMMENT: 9,

    ERROR: 99
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const CENTRAL_DIRECTORY_END_SIG = 0x06054b50;

function UnzipStream() {
    if (!(this instanceof UnzipStream)) {
        return new UnzipStream();
    }

    stream.Transform.call(this);

    this.data = new Buffer('');
    this.state = states.START;
    this.parsedEntity = null;
    this.outStreamInfo = {};
}

util.inherits(UnzipStream, stream.Transform);

UnzipStream.prototype.processDataChunk = function (chunk) {
    var requiredLength;

    switch (this.state) {
        case states.START:
            requiredLength = 4;
            break;
        case states.LOCAL_FILE_HEADER:
            requiredLength = 26;
            break;
        case states.LOCAL_FILE_HEADER_SUFFIX:
            requiredLength = this.parsedEntity.fileNameLength + this.parsedEntity.extraFieldLength;
            break;
        case states.DATA_DESCRIPTOR:
            requiredLength = 12;
            break;
        case states.CENTRAL_DIRECTORY_FILE_HEADER:
            requiredLength = 42;
            break;
        case states.CENTRAL_DIRECTORY_FILE_HEADER_SUFFIX:
            requiredLength = this.parsedEntity.fileNameLength + this.parsedEntity.extraFieldLength + this.parsedEntity.fileCommentLength;
            break;
        case states.CENTRAL_DIRECTORY_END:
            requiredLength = 18;
            break;
        case states.FILE_DATA:
            return 0;
        case states.FILE_DATA_END:
            return 0;
        default:
            return chunk.length;
    }

    var chunkLength = chunk.length;
    if (chunkLength < requiredLength) {
        return 0;
    }

    switch (this.state) {
        case states.START:
            switch (chunk.readUInt32LE(0)) {
                case LOCAL_FILE_HEADER_SIG:
                    this.state = states.LOCAL_FILE_HEADER;
                    break;
                case CENTRAL_DIRECTORY_SIG:
                    this.state = states.CENTRAL_DIRECTORY_FILE_HEADER;
                    break;
                case CENTRAL_DIRECTORY_END_SIG:
                    this.state = states.CENTRAL_DIRECTORY_END;
                    break;
                default:
                    this.state = states.ERROR;
                    this.emit("error", new Error("Invalid signature in zip file"));
                    return chunk.length;
            }
            return requiredLength;

        case states.LOCAL_FILE_HEADER:
            this.parsedEntity = this._readFile(chunk);
            this.state = states.LOCAL_FILE_HEADER_SUFFIX;

            return requiredLength;

        case states.LOCAL_FILE_HEADER_SUFFIX:
            var fileName = chunk.slice(0, this.parsedEntity.fileNameLength).toString();
            var entry = new Entry();
            entry.path = fileName;
            this._prepareOutStream(this.parsedEntity, entry);

            this.emit("entry", entry);

            this.state = states.FILE_DATA;

            return requiredLength;

        case states.CENTRAL_DIRECTORY_FILE_HEADER:
            this.parsedEntity = this._readCentralDirectoryEntry(chunk);
            this.state = states.CENTRAL_DIRECTORY_FILE_HEADER_SUFFIX;

            return requiredLength;

        case states.CENTRAL_DIRECTORY_FILE_HEADER_SUFFIX:
            // got file name in chunk[0..]
            this.state = states.START;

            return requiredLength;

        case states.CENTRAL_DIRECTORY_END:
            this.state = states.CENTRAL_DIRECTORY_END_COMMENT;

            return requiredLength;

        case states.CENTRAL_DIRECTORY_END_COMMENT:
            return chunk.length;

        case states.ERROR:
            return chunk.length; // discard

        default:
            console.log("didn't handle state #", this.state, "discarding");
            return chunk.length;
    }
}

UnzipStream.prototype._prepareOutStream = function (vars, entry) {
    var self = this;

    var isDirectory = vars.compressedSize === 0 && /[\/\\]$/.test(entry.path);
    entry.type = isDirectory ? 'Directory' : 'File';
    entry.isDirectory = isDirectory;

    var fileSizeKnown = !(vars.flags & 0x08);
    if (fileSizeKnown) {
        entry.size = vars.uncompressedSize;
    }

    this.outStreamInfo = {
        stream: null,
        limit: fileSizeKnown ? vars.compressedSize : -1,
        written: 0
    };

    if (!fileSizeKnown) {
        var pattern = new Buffer(4);
        pattern.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
        var searchPattern = {
            pattern: pattern,
            requiredExtraSize: 12
        }

        this.outStreamInfo.stream = new MatcherStream(searchPattern, function (matchedChunk, sizeSoFar) {
            var vars = self._readDataDescriptor(matchedChunk);

            if (vars.compressedSize !== sizeSoFar) {
                return;
            }

            self.state = states.FILE_DATA_END;
            if (self.data.length > 0) {
                self.data = Buffer.concat(matchedChunk.slice(16), self.data);
            } else {
                self.data = matchedChunk.slice(16);
            }

            return true;
        });
    } else {
        this.outStreamInfo.stream = new stream.PassThrough();
    }

    var isCompressed = vars.compressionMethod > 0;
    if (isCompressed) {
        var inflater = zlib.createInflateRaw();
        inflater.on('error', function (err) {
            self.state = states.ERROR;
            self.emit('error', err);
        });
        this.outStreamInfo.stream.pipe(inflater).pipe(entry);
    } else {
        this.outStreamInfo.stream.pipe(entry);
    }

    if (this._drainAllEntries) {
        entry.autodrain();
    }
}

UnzipStream.prototype._readFile = function (data) {
    var vars = binary.parse(data)
        .word16lu('versionsNeededToExtract')
        .word16lu('flags')
        .word16lu('compressionMethod')
        .word16lu('lastModifiedTime')
        .word16lu('lastModifiedDate')
        .word32lu('crc32')
        .word32lu('compressedSize')
        .word32lu('uncompressedSize')
        .word16lu('fileNameLength')
        .word16lu('extraFieldLength')
        .vars;

    return vars;
}

UnzipStream.prototype._readDataDescriptor = function (data) {
    var vars = binary.parse(data)
        .word32lu('dataDescriptorSignature')
        .word32lu('crc32')
        .word32lu('compressedSize')
        .word32lu('uncompressedSize')
        .vars;

    return vars;
}

UnzipStream.prototype._readCentralDirectoryEntry = function (data) {
    var vars = binary.parse(data)
        .word16lu('versionMadeBy')
        .word16lu('versionsNeededToExtract')
        .word16lu('flags')
        .word16lu('compressionMethod')
        .word16lu('lastModifiedTime')
        .word16lu('lastModifiedDate')
        .word32lu('crc32')
        .word32lu('compressedSize')
        .word32lu('uncompressedSize')
        .word16lu('fileNameLength')
        .word16lu('extraFieldLength')
        .word16lu('fileCommentLength')
        .word16lu('diskNumber')
        .word16lu('internalFileAttributes')
        .word32lu('externalFileAttributes')
        .word32lu('offsetToLocalFileHeader')
        .vars;

    return vars;
}

UnzipStream.prototype._readEndOfCentralDirectory = function (data) {
    var vars = binary.parse(data)
        .word16lu('diskNumber')
        .word16lu('diskStart')
        .word16lu('numberOfRecordsOnDisk')
        .word16lu('numberOfRecords')
        .word32lu('sizeOfCentralDirectory')
        .word32lu('offsetToStartOfCentralDirectory')
        .word16lu('commentLength')
        .vars;

    return vars;
}

UnzipStream.prototype._parseOrOutput = function (encoding, cb) {
    var consume;
    while ((consume = this.processDataChunk(this.data)) > 0) {
        this.data = this.data.slice(consume);
        if (this.data.length === 0) break;
    }

    if (this.state === states.FILE_DATA) {
        if (this.outStreamInfo.limit >= 0) {
            var remaining = this.outStreamInfo.limit - this.outStreamInfo.written;
            var packet;
            if (remaining < this.data.length) {
                packet = this.data.slice(0, remaining);
                this.data = this.data.slice(remaining);
            } else {
                packet = this.data;
                this.data = new Buffer('');
            }

            this.outStreamInfo.written += packet.length;
            if (this.outStreamInfo.limit === this.outStreamInfo.written) {
                this.state = states.START;

                this.outStreamInfo.stream.end(packet, encoding, cb);
            } else {
                this.outStreamInfo.stream.write(packet, encoding, cb);
            }
        } else {
            var packet = this.data;
            this.data = new Buffer('');

            this.outStreamInfo.written += packet.length;
            this.outStreamInfo.stream.write(packet, encoding, () => {
                if (this.state === states.FILE_DATA_END) {
                    this.state = states.START;
                    return this.outStreamInfo.stream.end(cb);
                }
                cb();
            });
            // we're writing into MatcherStream, it deals with stream end on its own
        }
        // we've written to the output stream, letting that write deal with the callback
        return;
    }

    cb();
}

UnzipStream.prototype.drainAll = function () {
    this._drainAllEntries = true;
}

UnzipStream.prototype._transform = function (chunk, encoding, cb) {
    var self = this;
    if (self.data.length > 0) {
        self.data = Buffer.concat([self.data, chunk]);
    } else {
        self.data = chunk;
    }

    var startDataLength = self.data.length;
    var done = function () {
        if (self.data.length > 0 && self.data.length < startDataLength) {
            startDataLength = self.data.length;
            self._parseOrOutput(encoding, done);
            return;
        }
        cb();
    };
    self._parseOrOutput(encoding, done);
}

UnzipStream.prototype._flush = function (cb) {
    if (this.data.length > 0) {
        var self = this;
        self._parseOrOutput('buffer', function () {
            if (self.data.length > 0) return setImmediate(function () { self._flush(cb); });
            cb();
        });

        return;
    }

    setImmediate(cb);
}

module.exports = UnzipStream;