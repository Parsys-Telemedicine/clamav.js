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

  initSocket (callback, filename) {
    const options = {
      port: this.port,
      host: this.host,
      timeout: this.timeout,
    };
    const socket = this.tlsOn ? tls.connect(options) : net.connect(options);

    socket.on('error', function (err) {
      callback(err, filename);
    }).on('timeout', function () {
      socket.destroy();
      callback(new Error('Socket connection timeout'), filename);
    });

    return socket;
  }

  scan (object, callback) {
    if (typeof object === 'string') {
      this.pathScan(object, callback);
    } else {
      this.streamScan(object, 'stream', callback);
    }
  }

  streamScan (stream, filename, callback) {
    let status = '';
    const socket = this.initSocket(callback, filename);

    socket.on('connect', function () {
      const channel = new ClamAVChannel();

      stream.pipe(channel).pipe(socket, { end: false }).on('data', function (data) {
        status += data;

        if (data.toString().indexOf('\n') !== -1) {
          socket.end();

          status = status.substring(0, status.indexOf('\n'));
          let result = status.match(/^stream: (.+) FOUND$/);

          if (result !== null) {
            callback(undefined, filename, result[1]);
          } else if (status === 'stream: OK') {
            callback(undefined, filename);
          } else {
            result = status.match(/^(.+) ERROR/);
            if (result != null) {
              callback(new Error(result[1]), filename);
            } else {
              callback(new Error('Malformed Response[' + status + ']'), filename);
            }
          }
        }
      }).on('end', function () {
        if (status === '') {
          callback(new Error('No response received from ClamAV. Consider increasing MaxThreads in clamd.conf'), filename);
        }
      }).on('error', function (err) {
        callback(new Error(err), filename);
      });
    });
  }

  fileScan (filename, callback) {
    const stream = fs.createReadStream(filename);
    this.streamScan(stream, filename, callback);
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
    const socket = this.initSocket(callback);

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
    const socket = this.initSocket(callback);

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
