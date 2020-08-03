const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { Transform } = require('stream');

class ClamAVChannel extends Transform {
  constructor(options) {
    super(options);
    this._streaming = false;
  }

  _transform(chunk, encoding, callback) {
    if (!this._streaming) {
      this.push('nINSTREAM\n');
      this._streaming = true;
    }

    const size = new Buffer(4);
    size.writeInt32BE(chunk.length, 0);
    this.push(size);
    this.push(chunk);

    callback();
  }

  _flush(callback) {
    const size = new Buffer(4);
    size.writeInt32BE(0, 0);
    this.push(size);

    callback();
  }
}

class ClamAV {
  constructor(port, host, tls_on, timeout) {
    this.port = port ? port : 3310;
    this.host = host ? host : 'localhost';
    this.tls_on = tls_on ? tls_on : false;
    this.timeout = timeout ? timeout : 20000;
  }

  initSocket(callback) {
    const options = {
      port: this.port,
      host: this.host,
      timeout: this.timeout,
    }
    this.socket = this.tls_on ? tls.connect(options) : net.connect(options);

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
      this.pathScan(object, callback);
    }
    else {
      this.streamScan(object, function(stream) {}, object, callback);
    }
  }

  streamScan(stream, object, callback) {
    let status = '';
    const socket = this.initSocket(callback);

    socket.connect(port, host, function() {
      const channel = new ClamAVChannel();

      stream.pipe(channel).pipe(socket).on('end', function() {
        if (status === '') {
          callback(new Error('No response received from ClamAV. Consider increasing MaxThreads in clamd.conf'), object);
        }
      }).on('error', function(err) {
        callback(new Error(err), object);
      });
    }).on('data', function(data) {
      status += data;

      if (data.toString().indexOf('\n') !== -1) {
        socket.destroy();
        status = status.substring(0, status.indexOf('\n'));
        let result = status.match(/^stream: (.+) FOUND$/);

        if (result !== null) {
          callback(undefined, object, result[1]);
        } else if (status === 'stream: OK') {
          callback(undefined, object);
        } else {
          result = status.match(/^(.+) ERROR/);
          if (result != null) {
            callback(new Error(result[1]), object);
          } else {
            callback(new Error('Malformed Response['+status+']'), object);
          }
        }
      }
    })
  }

  fileScan(filename, callback) {
    const stream = fs.createReadStream(filename);
    this.streamScan(stream, filename, callback);
  }

  pathScan(pathname, callback) {
    const instance = this;
    pathname = path.normalize(pathname);

    fs.stat(pathname, function(err, stats) {
      if (err) {
        callback(err, pathname);
      } else if (stats.isDirectory()) {
        fs.readdir(pathname, function(err, lists) {
          lists.forEach(function(entry) {
            instance.pathScan(path.join(pathname, entry), callback);
          });
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
