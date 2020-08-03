const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');
const tls = require('tls');
const Transform = require('stream').Transform;
util.inherits(ClamAVChannel, Transform);

function ClamAVChannel(options) {
  if (!(this instanceof ClamAVChannel))
    return new ClamAVChannel(options);

  Transform.call(this, options);
  this._inBody = false;
}
ClamAVChannel.prototype._transform = function(chunk, encoding, callback) {
  if (!this._inBody) {
    this.push('nINSTREAM\n');
    this._inBody = true;
  }

  const size = new Buffer(4);
  size.writeInt32BE(chunk.length, 0);
  this.push(size);
  this.push(chunk);

  callback();
};
ClamAVChannel.prototype._flush = function (callback) {
  const size = new Buffer(4);
  size.writeInt32BE(0, 0);
  this.push(size);

  callback();
};

class ClamAV {
  constructor(port, host, tls_on, timeout) {
    this.port = port ? port : 3310;
    this.host = host ? host : 'localhost';
    this.tls_on = host ? host : 'localhost';
    this.timeout = timeout ? timeout : 20000;
  }

  initSocket(callback) {
    const options = {
      port: this.port,
      host: this.host,
      timeout: this.timeout,
    }
    this.socket = tls_on ? tls.connect(options) : net.connect(options);

    this.socket.on('error', function(err) {
      socket.destroy();
      callback(err);
    }).on('timeout', function() {
      socket.destroy();
      callback(new Error('Socket connection timeout'));
    }).on('close', function() {});

    return socket;
  }

  scan(object, callback) {
    if (typeof object === 'string') {
      this.pathscan(object, callback);
    }
    else {
      this.streamscan(object, function(stream) {}, object, callback);
    }
  }

  streamscan = function(stream, complete, object, callback) {
    let status = '';
    const socket = this.initSocket(callback);

    socket.connect(port, host, function() {
      const channel = new ClamAVChannel();

      stream.pipe(channel).pipe(socket).on('end', function() {
        if (status === '') {
          callback(new Error('No response received from ClamAV. Consider increasing MaxThreads in clamd.conf'), object);
        }
        complete(stream);
      }).on('error', function(err) {
        callback(new Error(err), object);
        complete(stream);
      });
    }).on('data', function(data) {
      status += data;
      if (data.toString().indexOf('\n') !== -1) {
        socket.destroy();
        status = status.substring(0, status.indexOf('\n'));
        let result = status.match(/^stream: (.+) FOUND$/);
        if (result !== null) {
          callback(undefined, object, result[1]);
        }
        else if (status === 'stream: OK') {
          callback(undefined, object);
        }
        else {
          result = status.match(/^(.+) ERROR/);
          if (result != null) {
            callback(new Error(result[1]), object);
          }
          else {
            callback(new Error('Malformed Response['+status+']'), object);
          }
        }
      }
    })
  }

  filescan(filename, callback) {
    const stream = fs.createReadStream(filename);
    this.streamscan(stream, function(stream) { stream.destroy(); }, filename, callback);
  }

  pathscan(pathname, callback) {
    pathname = path.normalize(pathname);
    fs.stat(pathname, function(err, stats) {
      if (err) {
        callback(err, pathname);
      }
      else if (stats.isDirectory()) {
        fs.readdir(pathname, function(err, lists) {
          lists.forEach(function(entry) {
            this.pathscan(path.join(pathname, entry), callback);
          });
        });
      }
      else if (stats.isFile()) {
        this.filescan(pathname, callback);
      }
      else if (err) {
        callback(err, pathname);
      }
      else {
        callback(new Error('Not a regular file or directory'), pathname);
      }
    });
  }

  ping(callback) {
    let status = '';
    const socket = this.initSocket(callback);

    socket.on('data', function(data) {
      status += data;
      if (data.toString().indexOf('\n') !== -1) {
        socket.destroy();
        status = status.substring(0, status.indexOf('\n'));
        if (status === 'PONG') {
          callback();
        } else {
          callback(new Error('Invalid response('+status+')'));
        }
      }
    })
  }

  version(callback) {
    let status = '';
    const socket = this.initSocket(callback);

    socket.connect(port, host, function() {
      socket.write('nVERSION\n');
    }).on('data', function(data) {
      status += data;
      if (data.toString().indexOf('\n') !== -1) {
        socket.destroy();
        status = status.substring(0, status.indexOf('\n'));
        if (status.length > 0) {
          callback(undefined, status);
        } else {
          callback(new Error('Invalid response'));
        }
      }
    })
  }
}

module.exports = ClamAV;
