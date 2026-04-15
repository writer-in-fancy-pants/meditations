/**
 * lib/bleClient.js — Web Bluetooth BLE Heart Rate client
 *
 * Connects to any device that implements the standard GATT Heart Rate
 * Service (0x180D) — WHOOP, Polar, Garmin, generic chest straps, etc.
 * Parses the Heart Rate Measurement characteristic (0x2A37) and calls
 * an onData callback with { bpm, rrIntervals[] } on each notification.
 *
 * Depends on: lib/hrv.js  (HrvLib.parseGattHrMeasurement)
 *
 * Exported API:
 *   BleClient.connect({ onData, onStatus })   → Promise<void>
 *   BleClient.disconnect()
 *   BleClient.isConnected()                   → boolean
 *   BleClient.deviceName()                    → string|null
 *   BleClient.isSupported()                   → boolean
 */

'use strict';

const BleClient = (() => {

  const HR_SERVICE     = 0x180D;
  const HR_MEASUREMENT = 0x2A37;

  let _device   = null;
  let _char     = null;
  let _onData   = null;
  let _onStatus = null;

  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  function _emit(status, detail) {
    if (_onStatus) _onStatus(status, detail);
  }

  async function connect({ onData, onStatus } = {}) {
    if (!isSupported()) {
      throw new Error(
        'Web Bluetooth is not supported in this browser.\n' +
        'Use Chrome or Edge, or use the Python bridge instead.'
      );
    }

    _onData   = onData   || (() => {});
    _onStatus = onStatus || (() => {});

    _emit('connecting');

    try {
      _device = await navigator.bluetooth.requestDevice({
        filters:          [{ services: [HR_SERVICE] }],
        optionalServices: [HR_SERVICE],
      });

      _device.addEventListener('gattserverdisconnected', _onDisconnect);

      const server  = await _device.gatt.connect();
      const service = await server.getPrimaryService(HR_SERVICE);
      _char         = await service.getCharacteristic(HR_MEASUREMENT);

      _char.addEventListener('characteristicvaluechanged', _onNotification);
      await _char.startNotifications();

      _emit('connected', _device.name || 'HR device');
    } catch (err) {
      _device = null;
      _char   = null;
      // User cancelling the browser picker throws a DOMException — don't treat as error
      if (err.name !== 'NotFoundError' && !err.message?.includes('cancelled')) {
        _emit('error', err.message);
      }
      _emit('disconnected');
      throw err;
    }
  }

  function disconnect() {
    if (_char) {
      _char.removeEventListener('characteristicvaluechanged', _onNotification);
      try { _char.stopNotifications(); } catch(e) {}
      _char = null;
    }
    if (_device && _device.gatt?.connected) {
      try { _device.gatt.disconnect(); } catch(e) {}
    }
    _device = null;
    _emit('disconnected');
  }

  function _onDisconnect() {
    _char   = null;
    _device = null;
    _emit('disconnected');
  }

  function _onNotification(event) {
    if (!_onData) return;
    try {
      const parsed = HrvLib.parseGattHrMeasurement(event.target.value);
      _onData(parsed.bpm, parsed.rrIntervals);
    } catch(err) {
      console.warn('BLE parse error:', err);
    }
  }

  function isConnected() {
    return _device !== null && _device.gatt?.connected === true;
  }

  function deviceName() {
    return _device ? (_device.name || 'HR device') : null;
  }

  return { connect, disconnect, isConnected, deviceName, isSupported };

})();
