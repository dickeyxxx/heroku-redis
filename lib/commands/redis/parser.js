// The MIT License (MIT)
//
// Copyright (c) 2015 Zihua Li
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
'use strict';
let events = require('events');
let util = require('util');

function Packet(type, size) {
  this.type = type;
  this.size = +size;
}

function ReplyParser(options) {
  this.options = options || { };

  this._buffer            = null;
  this._offset            = 0;
  this._encoding          = 'utf-8';
  this._reply_type        = null;
}

util.inherits(ReplyParser, events.EventEmitter);

module.exports = ReplyParser;

ReplyParser.prototype._parseResult = function (type) {
  var start, end, offset, packetHeader;

  if (type === 43 || type === 45) { // + or -
    // up to the delimiter
    end = this._packetEndOffset() - 1;
    start = this._offset;

    // include the delimiter
    this._offset = end + 2;

    if (end > this._buffer.length) {
      this._offset = start;
      throw new Error('Wait for more data.');
    }

    if (type === 45) {
      return new Error(this._buffer.toString(this._encoding, start, end));
    }
    if (this.options.returnBuffers) {
      return this._buffer.slice(start, end);
    } else {
      return this._buffer.toString(this._encoding, start, end);
    }
  } else if (type === 58) { // :
    // up to the delimiter
    end = this._packetEndOffset() - 1;
    start = this._offset;

    // include the delimiter
    this._offset = end + 2;

    if (end > this._buffer.length) {
      this._offset = start;
      throw new Error('Wait for more data.');
    }

    // TODO number?
    // if (this.options.returnBuffers) {
    //   return this._buffer.slice(start, end);
    // }

    // return the coerced numeric value
    return this._buffer.toString(this._encoding, start, end);
  } else if (type === 36) { // $
    // set a rewind point, as the packet could be larger than the
    // buffer in memory
    offset = this._offset - 1;

    packetHeader = new Packet(type, this.parseHeader());

    // packets with a size of -1 are considered null
    if (packetHeader.size === -1) {
      return undefined;
    }

    end = this._offset + packetHeader.size;
    start = this._offset;

    // set the offset to after the delimiter
    this._offset = end + 2;

    if (end > this._buffer.length) {
      this._offset = offset;
      throw new Error('Wait for more data.');
    }

    if (this.options.returnBuffers) {
      return this._buffer.slice(start, end);
    } else {
      return this._buffer.toString(this._encoding, start, end);
    }
  } else if (type === 42) { // *
    offset = this._offset;
    packetHeader = new Packet(type, this.parseHeader());

    if (packetHeader.size < 0) {
      return null;
    }

    if (packetHeader.size > this._bytesRemaining()) {
      this._offset = offset - 1;
      throw new Error('Wait for more data.');
    }

    var reply = [ ];
    var ntype, i, res;

    offset = this._offset - 1;

    for (i = 0; i < packetHeader.size; i++) {
      ntype = this._buffer[this._offset++];

      if (this._offset > this._buffer.length) {
        throw new Error('Wait for more data.');
      }
      res = this._parseResult(ntype);
      if (res === undefined) {
        res = null;
      }
      reply.push(res);
    }

    return reply;
  }
};

ReplyParser.prototype.execute = function (buffer) {
  this.append(buffer);

  var type, ret, offset;

  while (true) {
    offset = this._offset;
    try {
      // at least 4 bytes: :1\r\n
      if (this._bytesRemaining() < 4) {
        break;
      }

      type = this._buffer[this._offset++];

      if (type === 43) { // +
        ret = this._parseResult(type);

        if (ret === null) {
          break;
        }

        this.send_reply(ret);
      } else  if (type === 45) { // -
        ret = this._parseResult(type);

        if (ret === null) {
          break;
        }

        this.send_error(ret);
      } else if (type === 58) { // :
        ret = this._parseResult(type);

        if (ret === null) {
          break;
        }

        this.send_reply(ret);
      } else if (type === 36) { // $
        ret = this._parseResult(type);

        if (ret === null) {
          break;
        }

        // check the state for what is the result of
        // a -1, set it back up for a null reply
        if (ret === undefined) {
          ret = null;
        }

        this.send_reply(ret);
      } else if (type === 42) { // *
        // set a rewind point. if a failure occurs,
        // wait for the next execute()/append() and try again
        offset = this._offset - 1;

        ret = this._parseResult(type);

        this.send_reply(ret);
      }
    } catch (err) {
      // catch the error (not enough data), rewind, and wait
      // for the next packet to appear
      if (! (err instanceof Error)) {
        throw err;
      }
      this._offset = offset;
      break;
    }
  }
};

ReplyParser.prototype.append = function (newBuffer) {
  if (!newBuffer) {
    return;
  }

  // first run
  if (this._buffer === null) {
    this._buffer = newBuffer;

    return;
  }

  // out of data
  if (this._offset >= this._buffer.length) {
    this._buffer = newBuffer;
    this._offset = 0;

    return;
  }

  this._buffer = Buffer.concat([this._buffer.slice(this._offset), newBuffer]);
  this._offset = 0;
};

ReplyParser.prototype.parseHeader = function () {
  var end   = this._packetEndOffset(),
    value = this._buffer.toString(this._encoding, this._offset, end - 1);

  this._offset = end + 1;

  return value;
};

ReplyParser.prototype._packetEndOffset = function () {
  var offset = this._offset;

  while (this._buffer[offset] !== 0x0d && this._buffer[offset + 1] !== 0x0a) {
    offset++;

    if (offset >= this._buffer.length) {
      throw new Error('didn\'t see LF after NL reading multi bulk count (' + offset + ' => ' + this._buffer.length + ', ' + this._offset + ')');
    }
  }

  offset++;
  return offset;
};

ReplyParser.prototype._bytesRemaining = function () {
  return (this._buffer.length - this._offset) < 0 ? 0 : (this._buffer.length - this._offset);
};

ReplyParser.prototype.send_error = function (reply) {
  this.emit('reply error', reply);
};

ReplyParser.prototype.send_reply = function (reply) {
  this.emit('reply', reply);
};