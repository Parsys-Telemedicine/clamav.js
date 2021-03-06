const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { Transform } = require('stream');

class ClamAVChannel extends Transform {
  constructor (options) {
    super(options);
    this._streaming = false;
  }

  _transform (chunk, encoding, callback) {
    if (!this._streaming) {
      this.push('nINSTREAM\n');
      this._streaming = true;
    }

    const size = Buffer.alloc(4);
    size.writeInt32BE(chunk.length, 0);
    this.push(size);
    this.push(chunk);

    callback();
  }

  _flush (callback) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(0, 0);
    this.push(size);

    callback();
  }
}

class ClamAV {
  constructor (port, host, tlsOn, timeout) {
    this.port = port || 3310;
    this.host = host || 'localhost';
    this.tlsOn = tlsOn || false;
    this.timeout = timeout || 20000;
  }

  initSocket (filename, callback) {
    const instance = this;

    const options = {
      port: this.port,
      host: this.host,
      timeout: this.timeout,
    };
    const socket = this.tlsOn ? tls.connect(options) : net.connect(options);

    socket.on('error', function (err) {
      instance.closeStream();
      callback(err, filename);
    }).on('timeout', function () {
      socket.destroy();
      instance.closeStream();
      callback(new Error('Socket connection timeout'), filename);
    });

    return socket;
  }

  closeStream () {
    if (this.stream) {
      this.stream.destroy();
      delete this.stream;
    }
  }

  scan (object, callback) {
    if (typeof object === 'string') {
      this.pathScan(object, callback);
    } else {
      this.streamScan(object, callback);
    }
  }

  streamScan (stream, callback) {
    const instance = this;
    let status = '';
    const socket = this.initSocket(stream.path, callback);

    socket.on('connect', function () {
      const channel = new ClamAVChannel();

      stream.pipe(channel).pipe(socket, { end: false }).on('data', function (data) {
        status += data;

        if (data.toString().indexOf('\n') !== -1) {
          socket.end();
          instance.closeStream();

          status = status.substring(0, status.indexOf('\n'));
          let result = status.match(/^stream: (.+) FOUND$/);

          if (result !== null) {
            callback(undefined, stream.path, result[1]);
          } else if (status === 'stream: OK') {
            callback(undefined, stream.path);
          } else {
            result = status.match(/^(.+) ERROR/);
            if (result != null) {
              callback(new Error(result[1]), stream.path);
            } else {
              callback(new Error('Malformed Response[' + status + ']'), stream.path);
            }
          }
        }
      }).on('end', function () {
        instance.closeStream();
        if (status === '') {
          callback(new Error('No response received from ClamAV. Consider increasing MaxThreads in clamd.conf'), stream.path);
        }
      }).on('error', function (err) {
        instance.closeStream();
        callback(new Error(err), stream.path);
      });
    });
  }

  fileScan (filename, callback) {
    const stream = fs.createReadStream(filename);
    this.stream = stream;
    this.streamScan(stream, callback);
  }

  pathScan (pathname, callback) {
    const instance = this;
    pathname = path.normalize(pathname);

    fs.stat(pathname, function (err, stats) {
      if (err) {
        callback(err, pathname);
      } else if (stats.isDirectory()) {
        fs.readdir(pathname, function (err, paths) {
          if (err) {
            callback(err, pathname);
          } else {
            paths.forEach(function (entry) {
              instance.pathScan(path.join(pathname, entry), callback);
            });
          }
        });
      } else if (stats.isFile()) {
        instance.fileScan(pathname, callback);
      } else if (err) {
        callback(err, pathname);
      } else {
        callback(new Error('Not a regular file or directory'), pathname);
      }
    });
  }

  ping (callback) {
    let status = '';
    const socket = this.initSocket('ping', callback);

    socket.on('connect', function () {
      socket.write('nPING\n');
    }).on('data', function (data) {
      status += data;

      if (data.toString().indexOf('\n') !== -1) {
        socket.end();

        status = status.substring(0, status.indexOf('\n'));
        if (status === 'PONG') {
          callback();
        } else {
          callback(new Error('Invalid response(' + status + ')'));
        }
      }
    });
  }

  version (callback) {
    let status = '';
    const socket = this.initSocket('version', callback);

    socket.on('connect', function () {
      socket.write('nVERSION\n');
    }).on('data', function (data) {
      status += data;

      if (data.toString().indexOf('\n') !== -1) {
        socket.end();

        status = status.substring(0, status.indexOf('\n'));
        if (status.length > 0) {
          callback(undefined, status);
        } else {
          callback(new Error('Invalid response'));
        }
      }
    });
  }
}

module.exports = ClamAV;
