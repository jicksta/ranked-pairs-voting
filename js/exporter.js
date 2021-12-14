"use strict";
(function() {

var $goVersion = "go1.17.2";
Error.stackTraceLimit = Infinity;

var $global, $module;
if (typeof window !== "undefined") { /* web page */
  $global = window;
} else if (typeof self !== "undefined") { /* web worker */
  $global = self;
} else if (typeof global !== "undefined") { /* Node.js */
  $global = global;
  $global.require = require;
} else { /* others (e.g. Nashorn) */
  $global = this;
}

if ($global === undefined || $global.Array === undefined) {
  throw new Error("no global object found");
}
if (typeof module !== "undefined") {
  $module = module;
}
var $linknames = {} // Collection of functions referenced by a go:linkname directive.
var $packages = {}, $idCounter = 0;
var $keys = function(m) { return m ? Object.keys(m) : []; };
var $flushConsole = function() {};
var $throwRuntimeError; /* set by package "runtime" */
var $throwNilPointerError = function() { $throwRuntimeError("invalid memory address or nil pointer dereference"); };
var $call = function(fn, rcvr, args) { return fn.apply(rcvr, args); };
var $makeFunc = function(fn) { return function() { return $externalize(fn(this, new ($sliceType($jsObjectPtr))($global.Array.prototype.slice.call(arguments, []))), $emptyInterface); }; };
var $unused = function(v) {};
var $print = console.log;
// Under Node we can emulate print() more closely by avoiding a newline.
if (($global.process !== undefined) && $global.require) {
  try {
    var util = $global.require('util');
    $print = function() { $global.process.stderr.write(util.format.apply(this, arguments)); };
  } catch (e) {
    // Failed to require util module, keep using console.log().
  }
}
var $println = console.log

var $initAllLinknames = function() {
  var names = $keys($packages);
  for (var i = 0; i < names.length; i++) {
    var f = $packages[names[i]]["$initLinknames"];
    if (typeof f == 'function') {
      f();
    }
  }
}

var $mapArray = function(array, f) {
  var newArray = new array.constructor(array.length);
  for (var i = 0; i < array.length; i++) {
    newArray[i] = f(array[i]);
  }
  return newArray;
};

var $methodVal = function(recv, name) {
  var vals = recv.$methodVals || {};
  recv.$methodVals = vals; /* noop for primitives */
  var f = vals[name];
  if (f !== undefined) {
    return f;
  }
  var method = recv[name];
  f = function() {
    $stackDepthOffset--;
    try {
      return method.apply(recv, arguments);
    } finally {
      $stackDepthOffset++;
    }
  };
  vals[name] = f;
  return f;
};

var $methodExpr = function(typ, name) {
  var method = typ.prototype[name];
  if (method.$expr === undefined) {
    method.$expr = function() {
      $stackDepthOffset--;
      try {
        if (typ.wrapped) {
          arguments[0] = new typ(arguments[0]);
        }
        return Function.call.apply(method, arguments);
      } finally {
        $stackDepthOffset++;
      }
    };
  }
  return method.$expr;
};

var $ifaceMethodExprs = {};
var $ifaceMethodExpr = function(name) {
  var expr = $ifaceMethodExprs["$" + name];
  if (expr === undefined) {
    expr = $ifaceMethodExprs["$" + name] = function() {
      $stackDepthOffset--;
      try {
        return Function.call.apply(arguments[0][name], arguments);
      } finally {
        $stackDepthOffset++;
      }
    };
  }
  return expr;
};

var $subslice = function(slice, low, high, max) {
  if (high === undefined) {
    high = slice.$length;
  }
  if (max === undefined) {
    max = slice.$capacity;
  }
  if (low < 0 || high < low || max < high || high > slice.$capacity || max > slice.$capacity) {
    $throwRuntimeError("slice bounds out of range");
  }
  if (slice === slice.constructor.nil) {
    return slice;
  }
  var s = new slice.constructor(slice.$array);
  s.$offset = slice.$offset + low;
  s.$length = high - low;
  s.$capacity = max - low;
  return s;
};

var $substring = function(str, low, high) {
  if (low < 0 || high < low || high > str.length) {
    $throwRuntimeError("slice bounds out of range");
  }
  return str.substring(low, high);
};

// Convert Go slice to an equivalent JS array type.
var $sliceToNativeArray = function(slice) {
  if (slice.$array.constructor !== Array) {
    return slice.$array.subarray(slice.$offset, slice.$offset + slice.$length);
  }
  return slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
};

// Convert Go slice to a pointer to an underlying Go array.
// 
// Note that an array pointer can be represented by an "unwrapped" native array
// type, and it will be wrapped back into its Go type when necessary.
var $sliceToGoArray = function(slice, arrayPtrType) {
  var arrayType = arrayPtrType.elem;
  if (arrayType !== undefined && slice.$length < arrayType.len) {
    $throwRuntimeError("cannot convert slice with length " + slice.$length + " to pointer to array with length " + arrayType.len);
  }
  if (slice == slice.constructor.nil) {
    return arrayPtrType.nil; // Nil slice converts to nil array pointer.
  }
  if (slice.$array.constructor !== Array) {
    return slice.$array.subarray(slice.$offset, slice.$offset + slice.$length);
  }
  if (slice.$offset == 0 && slice.$length == slice.$capacity && slice.$length == arrayType.len) {
    return slice.$array;
  }
  if (arrayType.len == 0) {
    return new arrayType([]);
  }

  // Array.slice (unlike TypedArray.subarray) returns a copy of an array range,
  // which is not sharing memory with the original one, which violates the spec
  // for slice to array conversion. This is incompatible with the Go spec, in
  // particular that the assignments to the array elements would be visible in
  // the slice. Prefer to fail explicitly instead of creating subtle bugs.
  $throwRuntimeError("gopherjs: non-numeric slice to underlying array conversion is not supported for subslices");
};

// Convert between compatible slice types (e.g. native and names).
var $convertSliceType = function(slice, desiredType) {
  if (slice == slice.constructor.nil) {
    return desiredType.nil; // Preserve nil value.
  }

  return $subslice(new desiredType(slice.$array), slice.$offset, slice.$offset + slice.$length);
}

var $decodeRune = function(str, pos) {
  var c0 = str.charCodeAt(pos);

  if (c0 < 0x80) {
    return [c0, 1];
  }

  if (c0 !== c0 || c0 < 0xC0) {
    return [0xFFFD, 1];
  }

  var c1 = str.charCodeAt(pos + 1);
  if (c1 !== c1 || c1 < 0x80 || 0xC0 <= c1) {
    return [0xFFFD, 1];
  }

  if (c0 < 0xE0) {
    var r = (c0 & 0x1F) << 6 | (c1 & 0x3F);
    if (r <= 0x7F) {
      return [0xFFFD, 1];
    }
    return [r, 2];
  }

  var c2 = str.charCodeAt(pos + 2);
  if (c2 !== c2 || c2 < 0x80 || 0xC0 <= c2) {
    return [0xFFFD, 1];
  }

  if (c0 < 0xF0) {
    var r = (c0 & 0x0F) << 12 | (c1 & 0x3F) << 6 | (c2 & 0x3F);
    if (r <= 0x7FF) {
      return [0xFFFD, 1];
    }
    if (0xD800 <= r && r <= 0xDFFF) {
      return [0xFFFD, 1];
    }
    return [r, 3];
  }

  var c3 = str.charCodeAt(pos + 3);
  if (c3 !== c3 || c3 < 0x80 || 0xC0 <= c3) {
    return [0xFFFD, 1];
  }

  if (c0 < 0xF8) {
    var r = (c0 & 0x07) << 18 | (c1 & 0x3F) << 12 | (c2 & 0x3F) << 6 | (c3 & 0x3F);
    if (r <= 0xFFFF || 0x10FFFF < r) {
      return [0xFFFD, 1];
    }
    return [r, 4];
  }

  return [0xFFFD, 1];
};

var $encodeRune = function(r) {
  if (r < 0 || r > 0x10FFFF || (0xD800 <= r && r <= 0xDFFF)) {
    r = 0xFFFD;
  }
  if (r <= 0x7F) {
    return String.fromCharCode(r);
  }
  if (r <= 0x7FF) {
    return String.fromCharCode(0xC0 | r >> 6, 0x80 | (r & 0x3F));
  }
  if (r <= 0xFFFF) {
    return String.fromCharCode(0xE0 | r >> 12, 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
  }
  return String.fromCharCode(0xF0 | r >> 18, 0x80 | (r >> 12 & 0x3F), 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
};

var $stringToBytes = function(str) {
  var array = new Uint8Array(str.length);
  for (var i = 0; i < str.length; i++) {
    array[i] = str.charCodeAt(i);
  }
  return array;
};

var $bytesToString = function(slice) {
  if (slice.$length === 0) {
    return "";
  }
  var str = "";
  for (var i = 0; i < slice.$length; i += 10000) {
    str += String.fromCharCode.apply(undefined, slice.$array.subarray(slice.$offset + i, slice.$offset + Math.min(slice.$length, i + 10000)));
  }
  return str;
};

var $stringToRunes = function(str) {
  var array = new Int32Array(str.length);
  var rune, j = 0;
  for (var i = 0; i < str.length; i += rune[1], j++) {
    rune = $decodeRune(str, i);
    array[j] = rune[0];
  }
  return array.subarray(0, j);
};

var $runesToString = function(slice) {
  if (slice.$length === 0) {
    return "";
  }
  var str = "";
  for (var i = 0; i < slice.$length; i++) {
    str += $encodeRune(slice.$array[slice.$offset + i]);
  }
  return str;
};

var $copyString = function(dst, src) {
  var n = Math.min(src.length, dst.$length);
  for (var i = 0; i < n; i++) {
    dst.$array[dst.$offset + i] = src.charCodeAt(i);
  }
  return n;
};

var $copySlice = function(dst, src) {
  var n = Math.min(src.$length, dst.$length);
  $copyArray(dst.$array, src.$array, dst.$offset, src.$offset, n, dst.constructor.elem);
  return n;
};

var $copyArray = function(dst, src, dstOffset, srcOffset, n, elem) {
  if (n === 0 || (dst === src && dstOffset === srcOffset)) {
    return;
  }

  if (src.subarray) {
    dst.set(src.subarray(srcOffset, srcOffset + n), dstOffset);
    return;
  }

  switch (elem.kind) {
  case $kindArray:
  case $kindStruct:
    if (dst === src && dstOffset > srcOffset) {
      for (var i = n - 1; i >= 0; i--) {
        elem.copy(dst[dstOffset + i], src[srcOffset + i]);
      }
      return;
    }
    for (var i = 0; i < n; i++) {
      elem.copy(dst[dstOffset + i], src[srcOffset + i]);
    }
    return;
  }

  if (dst === src && dstOffset > srcOffset) {
    for (var i = n - 1; i >= 0; i--) {
      dst[dstOffset + i] = src[srcOffset + i];
    }
    return;
  }
  for (var i = 0; i < n; i++) {
    dst[dstOffset + i] = src[srcOffset + i];
  }
};

var $clone = function(src, type) {
  var clone = type.zero();
  type.copy(clone, src);
  return clone;
};

var $pointerOfStructConversion = function(obj, type) {
  if(obj.$proxies === undefined) {
    obj.$proxies = {};
    obj.$proxies[obj.constructor.string] = obj;
  }
  var proxy = obj.$proxies[type.string];
  if (proxy === undefined) {
    var properties = {};
    for (var i = 0; i < type.elem.fields.length; i++) {
      (function(fieldProp) {
        properties[fieldProp] = {
          get: function() { return obj[fieldProp]; },
          set: function(value) { obj[fieldProp] = value; }
        };
      })(type.elem.fields[i].prop);
    }
    proxy = Object.create(type.prototype, properties);
    proxy.$val = proxy;
    obj.$proxies[type.string] = proxy;
    proxy.$proxies = obj.$proxies;
  }
  return proxy;
};

var $append = function(slice) {
  return $internalAppend(slice, arguments, 1, arguments.length - 1);
};

var $appendSlice = function(slice, toAppend) {
  if (toAppend.constructor === String) {
    var bytes = $stringToBytes(toAppend);
    return $internalAppend(slice, bytes, 0, bytes.length);
  }
  return $internalAppend(slice, toAppend.$array, toAppend.$offset, toAppend.$length);
};

var $internalAppend = function(slice, array, offset, length) {
  if (length === 0) {
    return slice;
  }

  var newArray = slice.$array;
  var newOffset = slice.$offset;
  var newLength = slice.$length + length;
  var newCapacity = slice.$capacity;

  if (newLength > newCapacity) {
    newOffset = 0;
    newCapacity = Math.max(newLength, slice.$capacity < 1024 ? slice.$capacity * 2 : Math.floor(slice.$capacity * 5 / 4));

    if (slice.$array.constructor === Array) {
      newArray = slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
      newArray.length = newCapacity;
      var zero = slice.constructor.elem.zero;
      for (var i = slice.$length; i < newCapacity; i++) {
        newArray[i] = zero();
      }
    } else {
      newArray = new slice.$array.constructor(newCapacity);
      newArray.set(slice.$array.subarray(slice.$offset, slice.$offset + slice.$length));
    }
  }

  $copyArray(newArray, array, newOffset + slice.$length, offset, length, slice.constructor.elem);

  var newSlice = new slice.constructor(newArray);
  newSlice.$offset = newOffset;
  newSlice.$length = newLength;
  newSlice.$capacity = newCapacity;
  return newSlice;
};

var $equal = function(a, b, type) {
  if (type === $jsObjectPtr) {
    return a === b;
  }
  switch (type.kind) {
  case $kindComplex64:
  case $kindComplex128:
    return a.$real === b.$real && a.$imag === b.$imag;
  case $kindInt64:
  case $kindUint64:
    return a.$high === b.$high && a.$low === b.$low;
  case $kindArray:
    if (a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if (!$equal(a[i], b[i], type.elem)) {
        return false;
      }
    }
    return true;
  case $kindStruct:
    for (var i = 0; i < type.fields.length; i++) {
      var f = type.fields[i];
      if (!$equal(a[f.prop], b[f.prop], f.typ)) {
        return false;
      }
    }
    return true;
  case $kindInterface:
    return $interfaceIsEqual(a, b);
  default:
    return a === b;
  }
};

var $interfaceIsEqual = function(a, b) {
  if (a === $ifaceNil || b === $ifaceNil) {
    return a === b;
  }
  if (a.constructor !== b.constructor) {
    return false;
  }
  if (a.constructor === $jsObjectPtr) {
    return a.object === b.object;
  }
  if (!a.constructor.comparable) {
    $throwRuntimeError("comparing uncomparable type " + a.constructor.string);
  }
  return $equal(a.$val, b.$val, a.constructor);
};

var $min = Math.min;
var $mod = function(x, y) { return x % y; };
var $parseInt = parseInt;
var $parseFloat = function(f) {
  if (f !== undefined && f !== null && f.constructor === Number) {
    return f;
  }
  return parseFloat(f);
};

var $froundBuf = new Float32Array(1);
var $fround = Math.fround || function(f) {
  $froundBuf[0] = f;
  return $froundBuf[0];
};

var $imul = Math.imul || function(a, b) {
  var ah = (a >>> 16) & 0xffff;
  var al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff;
  var bl = b & 0xffff;
  return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) >> 0);
};

var $floatKey = function(f) {
  if (f !== f) {
    $idCounter++;
    return "NaN$" + $idCounter;
  }
  return String(f);
};

var $flatten64 = function(x) {
  return x.$high * 4294967296 + x.$low;
};

var $shiftLeft64 = function(x, y) {
  if (y === 0) {
    return x;
  }
  if (y < 32) {
    return new x.constructor(x.$high << y | x.$low >>> (32 - y), (x.$low << y) >>> 0);
  }
  if (y < 64) {
    return new x.constructor(x.$low << (y - 32), 0);
  }
  return new x.constructor(0, 0);
};

var $shiftRightInt64 = function(x, y) {
  if (y === 0) {
    return x;
  }
  if (y < 32) {
    return new x.constructor(x.$high >> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
  }
  if (y < 64) {
    return new x.constructor(x.$high >> 31, (x.$high >> (y - 32)) >>> 0);
  }
  if (x.$high < 0) {
    return new x.constructor(-1, 4294967295);
  }
  return new x.constructor(0, 0);
};

var $shiftRightUint64 = function(x, y) {
  if (y === 0) {
    return x;
  }
  if (y < 32) {
    return new x.constructor(x.$high >>> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
  }
  if (y < 64) {
    return new x.constructor(0, x.$high >>> (y - 32));
  }
  return new x.constructor(0, 0);
};

var $mul64 = function(x, y) {
  var x48 = x.$high >>> 16;
  var x32 = x.$high & 0xFFFF;
  var x16 = x.$low >>> 16;
  var x00 = x.$low & 0xFFFF;

  var y48 = y.$high >>> 16;
  var y32 = y.$high & 0xFFFF;
  var y16 = y.$low >>> 16;
  var y00 = y.$low & 0xFFFF;

  var z48 = 0, z32 = 0, z16 = 0, z00 = 0;
  z00 += x00 * y00;
  z16 += z00 >>> 16;
  z00 &= 0xFFFF;
  z16 += x16 * y00;
  z32 += z16 >>> 16;
  z16 &= 0xFFFF;
  z16 += x00 * y16;
  z32 += z16 >>> 16;
  z16 &= 0xFFFF;
  z32 += x32 * y00;
  z48 += z32 >>> 16;
  z32 &= 0xFFFF;
  z32 += x16 * y16;
  z48 += z32 >>> 16;
  z32 &= 0xFFFF;
  z32 += x00 * y32;
  z48 += z32 >>> 16;
  z32 &= 0xFFFF;
  z48 += x48 * y00 + x32 * y16 + x16 * y32 + x00 * y48;
  z48 &= 0xFFFF;

  var hi = ((z48 << 16) | z32) >>> 0;
  var lo = ((z16 << 16) | z00) >>> 0;

  var r = new x.constructor(hi, lo);
  return r;
};

var $div64 = function(x, y, returnRemainder) {
  if (y.$high === 0 && y.$low === 0) {
    $throwRuntimeError("integer divide by zero");
  }

  var s = 1;
  var rs = 1;

  var xHigh = x.$high;
  var xLow = x.$low;
  if (xHigh < 0) {
    s = -1;
    rs = -1;
    xHigh = -xHigh;
    if (xLow !== 0) {
      xHigh--;
      xLow = 4294967296 - xLow;
    }
  }

  var yHigh = y.$high;
  var yLow = y.$low;
  if (y.$high < 0) {
    s *= -1;
    yHigh = -yHigh;
    if (yLow !== 0) {
      yHigh--;
      yLow = 4294967296 - yLow;
    }
  }

  var high = 0, low = 0, n = 0;
  while (yHigh < 2147483648 && ((xHigh > yHigh) || (xHigh === yHigh && xLow > yLow))) {
    yHigh = (yHigh << 1 | yLow >>> 31) >>> 0;
    yLow = (yLow << 1) >>> 0;
    n++;
  }
  for (var i = 0; i <= n; i++) {
    high = high << 1 | low >>> 31;
    low = (low << 1) >>> 0;
    if ((xHigh > yHigh) || (xHigh === yHigh && xLow >= yLow)) {
      xHigh = xHigh - yHigh;
      xLow = xLow - yLow;
      if (xLow < 0) {
        xHigh--;
        xLow += 4294967296;
      }
      low++;
      if (low === 4294967296) {
        high++;
        low = 0;
      }
    }
    yLow = (yLow >>> 1 | yHigh << (32 - 1)) >>> 0;
    yHigh = yHigh >>> 1;
  }

  if (returnRemainder) {
    return new x.constructor(xHigh * rs, xLow * rs);
  }
  return new x.constructor(high * s, low * s);
};

var $divComplex = function(n, d) {
  var ninf = n.$real === Infinity || n.$real === -Infinity || n.$imag === Infinity || n.$imag === -Infinity;
  var dinf = d.$real === Infinity || d.$real === -Infinity || d.$imag === Infinity || d.$imag === -Infinity;
  var nnan = !ninf && (n.$real !== n.$real || n.$imag !== n.$imag);
  var dnan = !dinf && (d.$real !== d.$real || d.$imag !== d.$imag);
  if(nnan || dnan) {
    return new n.constructor(NaN, NaN);
  }
  if (ninf && !dinf) {
    return new n.constructor(Infinity, Infinity);
  }
  if (!ninf && dinf) {
    return new n.constructor(0, 0);
  }
  if (d.$real === 0 && d.$imag === 0) {
    if (n.$real === 0 && n.$imag === 0) {
      return new n.constructor(NaN, NaN);
    }
    return new n.constructor(Infinity, Infinity);
  }
  var a = Math.abs(d.$real);
  var b = Math.abs(d.$imag);
  if (a <= b) {
    var ratio = d.$real / d.$imag;
    var denom = d.$real * ratio + d.$imag;
    return new n.constructor((n.$real * ratio + n.$imag) / denom, (n.$imag * ratio - n.$real) / denom);
  }
  var ratio = d.$imag / d.$real;
  var denom = d.$imag * ratio + d.$real;
  return new n.constructor((n.$imag * ratio + n.$real) / denom, (n.$imag - n.$real * ratio) / denom);
};

var $kindBool = 1;
var $kindInt = 2;
var $kindInt8 = 3;
var $kindInt16 = 4;
var $kindInt32 = 5;
var $kindInt64 = 6;
var $kindUint = 7;
var $kindUint8 = 8;
var $kindUint16 = 9;
var $kindUint32 = 10;
var $kindUint64 = 11;
var $kindUintptr = 12;
var $kindFloat32 = 13;
var $kindFloat64 = 14;
var $kindComplex64 = 15;
var $kindComplex128 = 16;
var $kindArray = 17;
var $kindChan = 18;
var $kindFunc = 19;
var $kindInterface = 20;
var $kindMap = 21;
var $kindPtr = 22;
var $kindSlice = 23;
var $kindString = 24;
var $kindStruct = 25;
var $kindUnsafePointer = 26;

var $methodSynthesizers = [];
var $addMethodSynthesizer = function(f) {
  if ($methodSynthesizers === null) {
    f();
    return;
  }
  $methodSynthesizers.push(f);
};
var $synthesizeMethods = function() {
  $methodSynthesizers.forEach(function(f) { f(); });
  $methodSynthesizers = null;
};

var $ifaceKeyFor = function(x) {
  if (x === $ifaceNil) {
    return 'nil';
  }
  var c = x.constructor;
  return c.string + '$' + c.keyFor(x.$val);
};

var $identity = function(x) { return x; };

var $typeIDCounter = 0;

var $idKey = function(x) {
  if (x.$id === undefined) {
    $idCounter++;
    x.$id = $idCounter;
  }
  return String(x.$id);
};

// Creates constructor functions for array pointer types. Returns a new function
// instace each time to make sure each type is independent of the other.
var $arrayPtrCtor = function() {
  return function(array) {
    this.$get = function() { return array; };
    this.$set = function(v) { typ.copy(this, v); };
    this.$val = array;
  }
}

var $newType = function(size, kind, string, named, pkg, exported, constructor) {
  var typ;
  switch(kind) {
  case $kindBool:
  case $kindInt:
  case $kindInt8:
  case $kindInt16:
  case $kindInt32:
  case $kindUint:
  case $kindUint8:
  case $kindUint16:
  case $kindUint32:
  case $kindUintptr:
  case $kindUnsafePointer:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = $identity;
    break;

  case $kindString:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = function(x) { return "$" + x; };
    break;

  case $kindFloat32:
  case $kindFloat64:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = function(x) { return $floatKey(x); };
    break;

  case $kindInt64:
    typ = function(high, low) {
      this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >> 0;
      this.$low = low >>> 0;
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$high + "$" + x.$low; };
    break;

  case $kindUint64:
    typ = function(high, low) {
      this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >>> 0;
      this.$low = low >>> 0;
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$high + "$" + x.$low; };
    break;

  case $kindComplex64:
    typ = function(real, imag) {
      this.$real = $fround(real);
      this.$imag = $fround(imag);
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$real + "$" + x.$imag; };
    break;

  case $kindComplex128:
    typ = function(real, imag) {
      this.$real = real;
      this.$imag = imag;
      this.$val = this;
    };
    typ.keyFor = function(x) { return x.$real + "$" + x.$imag; };
    break;

  case $kindArray:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.ptr = $newType(4, $kindPtr, "*" + string, false, "", false, $arrayPtrCtor());
    typ.init = function(elem, len) {
      typ.elem = elem;
      typ.len = len;
      typ.comparable = elem.comparable;
      typ.keyFor = function(x) {
        return Array.prototype.join.call($mapArray(x, function(e) {
          return String(elem.keyFor(e)).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
        }), "$");
      };
      typ.copy = function(dst, src) {
        $copyArray(dst, src, 0, 0, src.length, elem);
      };
      typ.ptr.init(typ);
      Object.defineProperty(typ.ptr.nil, "nilCheck", { get: $throwNilPointerError });
    };
    break;

  case $kindChan:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.keyFor = $idKey;
    typ.init = function(elem, sendOnly, recvOnly) {
      typ.elem = elem;
      typ.sendOnly = sendOnly;
      typ.recvOnly = recvOnly;
    };
    break;

  case $kindFunc:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.init = function(params, results, variadic) {
      typ.params = params;
      typ.results = results;
      typ.variadic = variadic;
      typ.comparable = false;
    };
    break;

  case $kindInterface:
    typ = { implementedBy: {}, missingMethodFor: {} };
    typ.keyFor = $ifaceKeyFor;
    typ.init = function(methods) {
      typ.methods = methods;
      methods.forEach(function(m) {
        $ifaceNil[m.prop] = $throwNilPointerError;
      });
    };
    break;

  case $kindMap:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.init = function(key, elem) {
      typ.key = key;
      typ.elem = elem;
      typ.comparable = false;
    };
    break;

  case $kindPtr:
    typ = constructor || function(getter, setter, target) {
      this.$get = getter;
      this.$set = setter;
      this.$target = target;
      this.$val = this;
    };
    typ.keyFor = $idKey;
    typ.init = function(elem) {
      typ.elem = elem;
      typ.wrapped = (elem.kind === $kindArray);
      typ.nil = new typ($throwNilPointerError, $throwNilPointerError);
    };
    break;

  case $kindSlice:
    typ = function(array) {
      if (array.constructor !== typ.nativeArray) {
        array = new typ.nativeArray(array);
      }
      this.$array = array;
      this.$offset = 0;
      this.$length = array.length;
      this.$capacity = array.length;
      this.$val = this;
    };
    typ.init = function(elem) {
      typ.elem = elem;
      typ.comparable = false;
      typ.nativeArray = $nativeArray(elem.kind);
      typ.nil = new typ([]);
    };
    break;

  case $kindStruct:
    typ = function(v) { this.$val = v; };
    typ.wrapped = true;
    typ.ptr = $newType(4, $kindPtr, "*" + string, false, pkg, exported, constructor);
    typ.ptr.elem = typ;
    typ.ptr.prototype.$get = function() { return this; };
    typ.ptr.prototype.$set = function(v) { typ.copy(this, v); };
    typ.init = function(pkgPath, fields) {
      typ.pkgPath = pkgPath;
      typ.fields = fields;
      fields.forEach(function(f) {
        if (!f.typ.comparable) {
          typ.comparable = false;
        }
      });
      typ.keyFor = function(x) {
        var val = x.$val;
        return $mapArray(fields, function(f) {
          return String(f.typ.keyFor(val[f.prop])).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
        }).join("$");
      };
      typ.copy = function(dst, src) {
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          switch (f.typ.kind) {
          case $kindArray:
          case $kindStruct:
            f.typ.copy(dst[f.prop], src[f.prop]);
            continue;
          default:
            dst[f.prop] = src[f.prop];
            continue;
          }
        }
      };
      /* nil value */
      var properties = {};
      fields.forEach(function(f) {
        properties[f.prop] = { get: $throwNilPointerError, set: $throwNilPointerError };
      });
      typ.ptr.nil = Object.create(constructor.prototype, properties);
      typ.ptr.nil.$val = typ.ptr.nil;
      /* methods for embedded fields */
      $addMethodSynthesizer(function() {
        var synthesizeMethod = function(target, m, f) {
          if (target.prototype[m.prop] !== undefined) { return; }
          target.prototype[m.prop] = function() {
            var v = this.$val[f.prop];
            if (f.typ === $jsObjectPtr) {
              v = new $jsObjectPtr(v);
            }
            if (v.$val === undefined) {
              v = new f.typ(v);
            }
            return v[m.prop].apply(v, arguments);
          };
        };
        fields.forEach(function(f) {
          if (f.embedded) {
            $methodSet(f.typ).forEach(function(m) {
              synthesizeMethod(typ, m, f);
              synthesizeMethod(typ.ptr, m, f);
            });
            $methodSet($ptrType(f.typ)).forEach(function(m) {
              synthesizeMethod(typ.ptr, m, f);
            });
          }
        });
      });
    };
    break;

  default:
    $panic(new $String("invalid kind: " + kind));
  }

  switch (kind) {
  case $kindBool:
  case $kindMap:
    typ.zero = function() { return false; };
    break;

  case $kindInt:
  case $kindInt8:
  case $kindInt16:
  case $kindInt32:
  case $kindUint:
  case $kindUint8 :
  case $kindUint16:
  case $kindUint32:
  case $kindUintptr:
  case $kindUnsafePointer:
  case $kindFloat32:
  case $kindFloat64:
    typ.zero = function() { return 0; };
    break;

  case $kindString:
    typ.zero = function() { return ""; };
    break;

  case $kindInt64:
  case $kindUint64:
  case $kindComplex64:
  case $kindComplex128:
    var zero = new typ(0, 0);
    typ.zero = function() { return zero; };
    break;

  case $kindPtr:
  case $kindSlice:
    typ.zero = function() { return typ.nil; };
    break;

  case $kindChan:
    typ.zero = function() { return $chanNil; };
    break;

  case $kindFunc:
    typ.zero = function() { return $throwNilPointerError; };
    break;

  case $kindInterface:
    typ.zero = function() { return $ifaceNil; };
    break;

  case $kindArray:
    typ.zero = function() {
      var arrayClass = $nativeArray(typ.elem.kind);
      if (arrayClass !== Array) {
        return new arrayClass(typ.len);
      }
      var array = new Array(typ.len);
      for (var i = 0; i < typ.len; i++) {
        array[i] = typ.elem.zero();
      }
      return array;
    };
    break;

  case $kindStruct:
    typ.zero = function() { return new typ.ptr(); };
    break;

  default:
    $panic(new $String("invalid kind: " + kind));
  }

  typ.id = $typeIDCounter;
  $typeIDCounter++;
  typ.size = size;
  typ.kind = kind;
  typ.string = string;
  typ.named = named;
  typ.pkg = pkg;
  typ.exported = exported;
  typ.methods = [];
  typ.methodSetCache = null;
  typ.comparable = true;
  return typ;
};

var $methodSet = function(typ) {
  if (typ.methodSetCache !== null) {
    return typ.methodSetCache;
  }
  var base = {};

  var isPtr = (typ.kind === $kindPtr);
  if (isPtr && typ.elem.kind === $kindInterface) {
    typ.methodSetCache = [];
    return [];
  }

  var current = [{typ: isPtr ? typ.elem : typ, indirect: isPtr}];

  var seen = {};

  while (current.length > 0) {
    var next = [];
    var mset = [];

    current.forEach(function(e) {
      if (seen[e.typ.string]) {
        return;
      }
      seen[e.typ.string] = true;

      if (e.typ.named) {
        mset = mset.concat(e.typ.methods);
        if (e.indirect) {
          mset = mset.concat($ptrType(e.typ).methods);
        }
      }

      switch (e.typ.kind) {
      case $kindStruct:
        e.typ.fields.forEach(function(f) {
          if (f.embedded) {
            var fTyp = f.typ;
            var fIsPtr = (fTyp.kind === $kindPtr);
            next.push({typ: fIsPtr ? fTyp.elem : fTyp, indirect: e.indirect || fIsPtr});
          }
        });
        break;

      case $kindInterface:
        mset = mset.concat(e.typ.methods);
        break;
      }
    });

    mset.forEach(function(m) {
      if (base[m.name] === undefined) {
        base[m.name] = m;
      }
    });

    current = next;
  }

  typ.methodSetCache = [];
  Object.keys(base).sort().forEach(function(name) {
    typ.methodSetCache.push(base[name]);
  });
  return typ.methodSetCache;
};

var $Bool          = $newType( 1, $kindBool,          "bool",           true, "", false, null);
var $Int           = $newType( 4, $kindInt,           "int",            true, "", false, null);
var $Int8          = $newType( 1, $kindInt8,          "int8",           true, "", false, null);
var $Int16         = $newType( 2, $kindInt16,         "int16",          true, "", false, null);
var $Int32         = $newType( 4, $kindInt32,         "int32",          true, "", false, null);
var $Int64         = $newType( 8, $kindInt64,         "int64",          true, "", false, null);
var $Uint          = $newType( 4, $kindUint,          "uint",           true, "", false, null);
var $Uint8         = $newType( 1, $kindUint8,         "uint8",          true, "", false, null);
var $Uint16        = $newType( 2, $kindUint16,        "uint16",         true, "", false, null);
var $Uint32        = $newType( 4, $kindUint32,        "uint32",         true, "", false, null);
var $Uint64        = $newType( 8, $kindUint64,        "uint64",         true, "", false, null);
var $Uintptr       = $newType( 4, $kindUintptr,       "uintptr",        true, "", false, null);
var $Float32       = $newType( 4, $kindFloat32,       "float32",        true, "", false, null);
var $Float64       = $newType( 8, $kindFloat64,       "float64",        true, "", false, null);
var $Complex64     = $newType( 8, $kindComplex64,     "complex64",      true, "", false, null);
var $Complex128    = $newType(16, $kindComplex128,    "complex128",     true, "", false, null);
var $String        = $newType( 8, $kindString,        "string",         true, "", false, null);
var $UnsafePointer = $newType( 4, $kindUnsafePointer, "unsafe.Pointer", true, "unsafe", false, null);

var $nativeArray = function(elemKind) {
  switch (elemKind) {
  case $kindInt:
    return Int32Array;
  case $kindInt8:
    return Int8Array;
  case $kindInt16:
    return Int16Array;
  case $kindInt32:
    return Int32Array;
  case $kindUint:
    return Uint32Array;
  case $kindUint8:
    return Uint8Array;
  case $kindUint16:
    return Uint16Array;
  case $kindUint32:
    return Uint32Array;
  case $kindUintptr:
    return Uint32Array;
  case $kindFloat32:
    return Float32Array;
  case $kindFloat64:
    return Float64Array;
  default:
    return Array;
  }
};
var $toNativeArray = function(elemKind, array) {
  var nativeArray = $nativeArray(elemKind);
  if (nativeArray === Array) {
    return array;
  }
  return new nativeArray(array);
};
var $arrayTypes = {};
var $arrayType = function(elem, len) {
  var typeKey = elem.id + "$" + len;
  var typ = $arrayTypes[typeKey];
  if (typ === undefined) {
    typ = $newType(12, $kindArray, "[" + len + "]" + elem.string, false, "", false, null);
    $arrayTypes[typeKey] = typ;
    typ.init(elem, len);
  }
  return typ;
};

var $chanType = function(elem, sendOnly, recvOnly) {
  var string = (recvOnly ? "<-" : "") + "chan" + (sendOnly ? "<- " : " ");
  if (!sendOnly && !recvOnly && (elem.string[0] == "<")) {
    string += "(" + elem.string + ")";
  } else {
    string += elem.string;
  }
  var field = sendOnly ? "SendChan" : (recvOnly ? "RecvChan" : "Chan");
  var typ = elem[field];
  if (typ === undefined) {
    typ = $newType(4, $kindChan, string, false, "", false, null);
    elem[field] = typ;
    typ.init(elem, sendOnly, recvOnly);
  }
  return typ;
};
var $Chan = function(elem, capacity) {
  if (capacity < 0 || capacity > 2147483647) {
    $throwRuntimeError("makechan: size out of range");
  }
  this.$elem = elem;
  this.$capacity = capacity;
  this.$buffer = [];
  this.$sendQueue = [];
  this.$recvQueue = [];
  this.$closed = false;
};
var $chanNil = new $Chan(null, 0);
$chanNil.$sendQueue = $chanNil.$recvQueue = { length: 0, push: function() {}, shift: function() { return undefined; }, indexOf: function() { return -1; } };

var $funcTypes = {};
var $funcType = function(params, results, variadic) {
  var typeKey = $mapArray(params, function(p) { return p.id; }).join(",") + "$" + $mapArray(results, function(r) { return r.id; }).join(",") + "$" + variadic;
  var typ = $funcTypes[typeKey];
  if (typ === undefined) {
    var paramTypes = $mapArray(params, function(p) { return p.string; });
    if (variadic) {
      paramTypes[paramTypes.length - 1] = "..." + paramTypes[paramTypes.length - 1].substr(2);
    }
    var string = "func(" + paramTypes.join(", ") + ")";
    if (results.length === 1) {
      string += " " + results[0].string;
    } else if (results.length > 1) {
      string += " (" + $mapArray(results, function(r) { return r.string; }).join(", ") + ")";
    }
    typ = $newType(4, $kindFunc, string, false, "", false, null);
    $funcTypes[typeKey] = typ;
    typ.init(params, results, variadic);
  }
  return typ;
};

var $interfaceTypes = {};
var $interfaceType = function(methods) {
  var typeKey = $mapArray(methods, function(m) { return m.pkg + "," + m.name + "," + m.typ.id; }).join("$");
  var typ = $interfaceTypes[typeKey];
  if (typ === undefined) {
    var string = "interface {}";
    if (methods.length !== 0) {
      string = "interface { " + $mapArray(methods, function(m) {
        return (m.pkg !== "" ? m.pkg + "." : "") + m.name + m.typ.string.substr(4);
      }).join("; ") + " }";
    }
    typ = $newType(8, $kindInterface, string, false, "", false, null);
    $interfaceTypes[typeKey] = typ;
    typ.init(methods);
  }
  return typ;
};
var $emptyInterface = $interfaceType([]);
var $ifaceNil = {};
var $error = $newType(8, $kindInterface, "error", true, "", false, null);
$error.init([{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}]);

var $mapTypes = {};
var $mapType = function(key, elem) {
  var typeKey = key.id + "$" + elem.id;
  var typ = $mapTypes[typeKey];
  if (typ === undefined) {
    typ = $newType(4, $kindMap, "map[" + key.string + "]" + elem.string, false, "", false, null);
    $mapTypes[typeKey] = typ;
    typ.init(key, elem);
  }
  return typ;
};
var $makeMap = function(keyForFunc, entries) {
  var m = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    m[keyForFunc(e.k)] = e;
  }
  return m;
};

var $ptrType = function(elem) {
  var typ = elem.ptr;
  if (typ === undefined) {
    typ = $newType(4, $kindPtr, "*" + elem.string, false, "", elem.exported, null);
    elem.ptr = typ;
    typ.init(elem);
  }
  return typ;
};

var $newDataPointer = function(data, constructor) {
  if (constructor.elem.kind === $kindStruct) {
    return data;
  }
  return new constructor(function() { return data; }, function(v) { data = v; });
};

var $indexPtr = function(array, index, constructor) {
  if (array.buffer) {
    // Pointers to the same underlying ArrayBuffer share cache.
    var cache = array.buffer.$ptr = array.buffer.$ptr || {};
    // Pointers of different primitive types are non-comparable and stored in different caches.
    var typeCache = cache[array.name] = cache[array.name] || {};
    var cacheIdx = array.BYTES_PER_ELEMENT * index + array.byteOffset;
    return typeCache[cacheIdx] || (typeCache[cacheIdx] = new constructor(function() { return array[index]; }, function(v) { array[index] = v; }));
  } else {
    array.$ptr = array.$ptr || {};
    return array.$ptr[index] || (array.$ptr[index] = new constructor(function() { return array[index]; }, function(v) { array[index] = v; }));
  }
};

var $sliceType = function(elem) {
  var typ = elem.slice;
  if (typ === undefined) {
    typ = $newType(12, $kindSlice, "[]" + elem.string, false, "", false, null);
    elem.slice = typ;
    typ.init(elem);
  }
  return typ;
};
var $makeSlice = function(typ, length, capacity) {
  capacity = capacity || length;
  if (length < 0 || length > 2147483647) {
    $throwRuntimeError("makeslice: len out of range");
  }
  if (capacity < 0 || capacity < length || capacity > 2147483647) {
    $throwRuntimeError("makeslice: cap out of range");
  }
  var array = new typ.nativeArray(capacity);
  if (typ.nativeArray === Array) {
    for (var i = 0; i < capacity; i++) {
      array[i] = typ.elem.zero();
    }
  }
  var slice = new typ(array);
  slice.$length = length;
  return slice;
};

var $structTypes = {};
var $structType = function(pkgPath, fields) {
  var typeKey = $mapArray(fields, function(f) { return f.name + "," + f.typ.id + "," + f.tag; }).join("$");
  var typ = $structTypes[typeKey];
  if (typ === undefined) {
    var string = "struct { " + $mapArray(fields, function(f) {
      var str = f.typ.string + (f.tag !== "" ? (" \"" + f.tag.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"") : "");
      if (f.embedded) {
        return str;
      }
      return f.name + " " + str;
    }).join("; ") + " }";
    if (fields.length === 0) {
      string = "struct {}";
    }
    typ = $newType(0, $kindStruct, string, false, "", false, function() {
      this.$val = this;
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.name == '_') {
          continue;
        }
        var arg = arguments[i];
        this[f.prop] = arg !== undefined ? arg : f.typ.zero();
      }
    });
    $structTypes[typeKey] = typ;
    typ.init(pkgPath, fields);
  }
  return typ;
};

var $assertType = function(value, type, returnTuple) {
  var isInterface = (type.kind === $kindInterface), ok, missingMethod = "";
  if (value === $ifaceNil) {
    ok = false;
  } else if (!isInterface) {
    ok = value.constructor === type;
  } else {
    var valueTypeString = value.constructor.string;
    ok = type.implementedBy[valueTypeString];
    if (ok === undefined) {
      ok = true;
      var valueMethodSet = $methodSet(value.constructor);
      var interfaceMethods = type.methods;
      for (var i = 0; i < interfaceMethods.length; i++) {
        var tm = interfaceMethods[i];
        var found = false;
        for (var j = 0; j < valueMethodSet.length; j++) {
          var vm = valueMethodSet[j];
          if (vm.name === tm.name && vm.pkg === tm.pkg && vm.typ === tm.typ) {
            found = true;
            break;
          }
        }
        if (!found) {
          ok = false;
          type.missingMethodFor[valueTypeString] = tm.name;
          break;
        }
      }
      type.implementedBy[valueTypeString] = ok;
    }
    if (!ok) {
      missingMethod = type.missingMethodFor[valueTypeString];
    }
  }

  if (!ok) {
    if (returnTuple) {
      return [type.zero(), false];
    }
    $panic(new $packages["runtime"].TypeAssertionError.ptr(
      $packages["runtime"]._type.ptr.nil,
      (value === $ifaceNil ? $packages["runtime"]._type.ptr.nil : new $packages["runtime"]._type.ptr(value.constructor.string)),
      new $packages["runtime"]._type.ptr(type.string),
      missingMethod));
  }

  if (!isInterface) {
    value = value.$val;
  }
  if (type === $jsObjectPtr) {
    value = value.object;
  }
  return returnTuple ? [value, true] : value;
};

var $stackDepthOffset = 0;
var $getStackDepth = function() {
  var err = new Error();
  if (err.stack === undefined) {
    return undefined;
  }
  return $stackDepthOffset + err.stack.split("\n").length;
};

var $panicStackDepth = null, $panicValue;
var $callDeferred = function(deferred, jsErr, fromPanic) {
  if (!fromPanic && deferred !== null && $curGoroutine.deferStack.indexOf(deferred) == -1) {
    throw jsErr;
  }
  if (jsErr !== null) {
    var newErr = null;
    try {
      $panic(new $jsErrorPtr(jsErr));
    } catch (err) {
      newErr = err;
    }
    $callDeferred(deferred, newErr);
    return;
  }
  if ($curGoroutine.asleep) {
    return;
  }

  $stackDepthOffset--;
  var outerPanicStackDepth = $panicStackDepth;
  var outerPanicValue = $panicValue;

  var localPanicValue = $curGoroutine.panicStack.pop();
  if (localPanicValue !== undefined) {
    $panicStackDepth = $getStackDepth();
    $panicValue = localPanicValue;
  }

  try {
    while (true) {
      if (deferred === null) {
        deferred = $curGoroutine.deferStack[$curGoroutine.deferStack.length - 1];
        if (deferred === undefined) {
          /* The panic reached the top of the stack. Clear it and throw it as a JavaScript error. */
          $panicStackDepth = null;
          if (localPanicValue.Object instanceof Error) {
            throw localPanicValue.Object;
          }
          var msg;
          if (localPanicValue.constructor === $String) {
            msg = localPanicValue.$val;
          } else if (localPanicValue.Error !== undefined) {
            msg = localPanicValue.Error();
          } else if (localPanicValue.String !== undefined) {
            msg = localPanicValue.String();
          } else {
            msg = localPanicValue;
          }
          throw new Error(msg);
        }
      }
      var call = deferred.pop();
      if (call === undefined) {
        $curGoroutine.deferStack.pop();
        if (localPanicValue !== undefined) {
          deferred = null;
          continue;
        }
        return;
      }
      var r = call[0].apply(call[2], call[1]);
      if (r && r.$blk !== undefined) {
        deferred.push([r.$blk, [], r]);
        if (fromPanic) {
          throw null;
        }
        return;
      }

      if (localPanicValue !== undefined && $panicStackDepth === null) {
        /* error was recovered */
        if (fromPanic) {
          throw null;
        }
        return;
      }
    }
  } catch(e) {
    // Deferred function threw a JavaScript exception or tries to unwind stack
    // to the point where a panic was handled.
    if (fromPanic) {
      // Re-throw the exception to reach deferral execution call at the end
      // of the function.
      throw e;
    }
    // We are at the end of the function, handle the error or re-throw to
    // continue unwinding if necessary, or simply stop unwinding if we got far
    // enough.
    $callDeferred(deferred, e, fromPanic);
  } finally {
    if (localPanicValue !== undefined) {
      if ($panicStackDepth !== null) {
        $curGoroutine.panicStack.push(localPanicValue);
      }
      $panicStackDepth = outerPanicStackDepth;
      $panicValue = outerPanicValue;
    }
    $stackDepthOffset++;
  }
};

var $panic = function(value) {
  $curGoroutine.panicStack.push(value);
  $callDeferred(null, null, true);
};
var $recover = function() {
  if ($panicStackDepth === null || ($panicStackDepth !== undefined && $panicStackDepth !== $getStackDepth() - 2)) {
    return $ifaceNil;
  }
  $panicStackDepth = null;
  return $panicValue;
};
var $throw = function(err) { throw err; };

var $noGoroutine = { asleep: false, exit: false, deferStack: [], panicStack: [] };
var $curGoroutine = $noGoroutine, $totalGoroutines = 0, $awakeGoroutines = 0, $checkForDeadlock = true, $exportedFunctions = 0;
var $mainFinished = false;
var $go = function(fun, args) {
  $totalGoroutines++;
  $awakeGoroutines++;
  var $goroutine = function() {
    try {
      $curGoroutine = $goroutine;
      var r = fun.apply(undefined, args);
      if (r && r.$blk !== undefined) {
        fun = function() { return r.$blk(); };
        args = [];
        return;
      }
      $goroutine.exit = true;
    } catch (err) {
      if (!$goroutine.exit) {
        throw err;
      }
    } finally {
      $curGoroutine = $noGoroutine;
      if ($goroutine.exit) { /* also set by runtime.Goexit() */
        $totalGoroutines--;
        $goroutine.asleep = true;
      }
      if ($goroutine.asleep) {
        $awakeGoroutines--;
        if (!$mainFinished && $awakeGoroutines === 0 && $checkForDeadlock && $exportedFunctions === 0) {
          console.error("fatal error: all goroutines are asleep - deadlock!");
          if ($global.process !== undefined) {
            $global.process.exit(2);
          }
        }
      }
    }
  };
  $goroutine.asleep = false;
  $goroutine.exit = false;
  $goroutine.deferStack = [];
  $goroutine.panicStack = [];
  $schedule($goroutine);
};

var $scheduled = [];
var $runScheduled = function() {
  // For nested setTimeout calls browsers enforce 4ms minimum delay. We minimize
  // the effect of this penalty by queueing the timer preemptively before we run
  // the goroutines, and later cancelling it if it turns out unneeded. See:
  // https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#nested_timeouts
  var nextRun = setTimeout($runScheduled);
  try {
    var start = Date.now();
    var r;
    while ((r = $scheduled.shift()) !== undefined) {
      r();
      // We need to interrupt this loop in order to allow the event loop to
      // process timers, IO, etc. However, invoking scheduling through
      // setTimeout is ~1000 times more expensive, so we amortize this cost by
      // looping until the 4ms minimal delay has elapsed (assuming there are
      // scheduled goroutines to run), and then yield to the event loop.
      var elapsed = Date.now() - start;
      if (elapsed > 4 || elapsed < 0) { break; }
    }
  } finally {
    if ($scheduled.length == 0) {
      // Cancel scheduling pass if there's nothing to run.
      clearTimeout(nextRun);
    }
  }
};

var $schedule = function(goroutine) {
  if (goroutine.asleep) {
    goroutine.asleep = false;
    $awakeGoroutines++;
  }
  $scheduled.push(goroutine);
  if ($curGoroutine === $noGoroutine) {
    $runScheduled();
  }
};

var $setTimeout = function(f, t) {
  $awakeGoroutines++;
  return setTimeout(function() {
    $awakeGoroutines--;
    f();
  }, t);
};

var $block = function() {
  if ($curGoroutine === $noGoroutine) {
    $throwRuntimeError("cannot block in JavaScript callback, fix by wrapping code in goroutine");
  }
  $curGoroutine.asleep = true;
};

var $send = function(chan, value) {
  if (chan.$closed) {
    $throwRuntimeError("send on closed channel");
  }
  var queuedRecv = chan.$recvQueue.shift();
  if (queuedRecv !== undefined) {
    queuedRecv([value, true]);
    return;
  }
  if (chan.$buffer.length < chan.$capacity) {
    chan.$buffer.push(value);
    return;
  }

  var thisGoroutine = $curGoroutine;
  var closedDuringSend;
  chan.$sendQueue.push(function(closed) {
    closedDuringSend = closed;
    $schedule(thisGoroutine);
    return value;
  });
  $block();
  return {
    $blk: function() {
      if (closedDuringSend) {
        $throwRuntimeError("send on closed channel");
      }
    }
  };
};
var $recv = function(chan) {
  var queuedSend = chan.$sendQueue.shift();
  if (queuedSend !== undefined) {
    chan.$buffer.push(queuedSend(false));
  }
  var bufferedValue = chan.$buffer.shift();
  if (bufferedValue !== undefined) {
    return [bufferedValue, true];
  }
  if (chan.$closed) {
    return [chan.$elem.zero(), false];
  }

  var thisGoroutine = $curGoroutine;
  var f = { $blk: function() { return this.value; } };
  var queueEntry = function(v) {
    f.value = v;
    $schedule(thisGoroutine);
  };
  chan.$recvQueue.push(queueEntry);
  $block();
  return f;
};
var $close = function(chan) {
  if (chan.$closed) {
    $throwRuntimeError("close of closed channel");
  }
  chan.$closed = true;
  while (true) {
    var queuedSend = chan.$sendQueue.shift();
    if (queuedSend === undefined) {
      break;
    }
    queuedSend(true); /* will panic */
  }
  while (true) {
    var queuedRecv = chan.$recvQueue.shift();
    if (queuedRecv === undefined) {
      break;
    }
    queuedRecv([chan.$elem.zero(), false]);
  }
};
var $select = function(comms) {
  var ready = [];
  var selection = -1;
  for (var i = 0; i < comms.length; i++) {
    var comm = comms[i];
    var chan = comm[0];
    switch (comm.length) {
    case 0: /* default */
      selection = i;
      break;
    case 1: /* recv */
      if (chan.$sendQueue.length !== 0 || chan.$buffer.length !== 0 || chan.$closed) {
        ready.push(i);
      }
      break;
    case 2: /* send */
      if (chan.$closed) {
        $throwRuntimeError("send on closed channel");
      }
      if (chan.$recvQueue.length !== 0 || chan.$buffer.length < chan.$capacity) {
        ready.push(i);
      }
      break;
    }
  }

  if (ready.length !== 0) {
    selection = ready[Math.floor(Math.random() * ready.length)];
  }
  if (selection !== -1) {
    var comm = comms[selection];
    switch (comm.length) {
    case 0: /* default */
      return [selection];
    case 1: /* recv */
      return [selection, $recv(comm[0])];
    case 2: /* send */
      $send(comm[0], comm[1]);
      return [selection];
    }
  }

  var entries = [];
  var thisGoroutine = $curGoroutine;
  var f = { $blk: function() { return this.selection; } };
  var removeFromQueues = function() {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var queue = entry[0];
      var index = queue.indexOf(entry[1]);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }
  };
  for (var i = 0; i < comms.length; i++) {
    (function(i) {
      var comm = comms[i];
      switch (comm.length) {
      case 1: /* recv */
        var queueEntry = function(value) {
          f.selection = [i, value];
          removeFromQueues();
          $schedule(thisGoroutine);
        };
        entries.push([comm[0].$recvQueue, queueEntry]);
        comm[0].$recvQueue.push(queueEntry);
        break;
      case 2: /* send */
        var queueEntry = function() {
          if (comm[0].$closed) {
            $throwRuntimeError("send on closed channel");
          }
          f.selection = [i];
          removeFromQueues();
          $schedule(thisGoroutine);
          return comm[1];
        };
        entries.push([comm[0].$sendQueue, queueEntry]);
        comm[0].$sendQueue.push(queueEntry);
        break;
      }
    })(i);
  }
  $block();
  return f;
};

var $jsObjectPtr, $jsErrorPtr;

var $needsExternalization = function(t) {
  switch (t.kind) {
    case $kindBool:
    case $kindInt:
    case $kindInt8:
    case $kindInt16:
    case $kindInt32:
    case $kindUint:
    case $kindUint8:
    case $kindUint16:
    case $kindUint32:
    case $kindUintptr:
    case $kindFloat32:
    case $kindFloat64:
      return false;
    default:
      return t !== $jsObjectPtr;
  }
};

var $externalize = function(v, t) {
  if (t === $jsObjectPtr) {
    return v;
  }
  switch (t.kind) {
  case $kindBool:
  case $kindInt:
  case $kindInt8:
  case $kindInt16:
  case $kindInt32:
  case $kindUint:
  case $kindUint8:
  case $kindUint16:
  case $kindUint32:
  case $kindUintptr:
  case $kindFloat32:
  case $kindFloat64:
    return v;
  case $kindInt64:
  case $kindUint64:
    return $flatten64(v);
  case $kindArray:
    if ($needsExternalization(t.elem)) {
      return $mapArray(v, function(e) { return $externalize(e, t.elem); });
    }
    return v;
  case $kindFunc:
    return $externalizeFunction(v, t, false);
  case $kindInterface:
    if (v === $ifaceNil) {
      return null;
    }
    if (v.constructor === $jsObjectPtr) {
      return v.$val.object;
    }
    return $externalize(v.$val, v.constructor);
  case $kindMap:
    var m = {};
    var keys = $keys(v);
    for (var i = 0; i < keys.length; i++) {
      var entry = v[keys[i]];
      m[$externalize(entry.k, t.key)] = $externalize(entry.v, t.elem);
    }
    return m;
  case $kindPtr:
    if (v === t.nil) {
      return null;
    }
    return $externalize(v.$get(), t.elem);
  case $kindSlice:
    if ($needsExternalization(t.elem)) {
      return $mapArray($sliceToNativeArray(v), function(e) { return $externalize(e, t.elem); });
    }
    return $sliceToNativeArray(v);
  case $kindString:
    if ($isASCII(v)) {
      return v;
    }
    var s = "", r;
    for (var i = 0; i < v.length; i += r[1]) {
      r = $decodeRune(v, i);
      var c = r[0];
      if (c > 0xFFFF) {
        var h = Math.floor((c - 0x10000) / 0x400) + 0xD800;
        var l = (c - 0x10000) % 0x400 + 0xDC00;
        s += String.fromCharCode(h, l);
        continue;
      }
      s += String.fromCharCode(c);
    }
    return s;
  case $kindStruct:
    var timePkg = $packages["time"];
    if (timePkg !== undefined && v.constructor === timePkg.Time.ptr) {
      var milli = $div64(v.UnixNano(), new $Int64(0, 1000000));
      return new Date($flatten64(milli));
    }

    var noJsObject = {};
    var searchJsObject = function(v, t) {
      if (t === $jsObjectPtr) {
        return v;
      }
      switch (t.kind) {
      case $kindPtr:
        if (v === t.nil) {
          return noJsObject;
        }
        return searchJsObject(v.$get(), t.elem);
      case $kindStruct:
        var f = t.fields[0];
        return searchJsObject(v[f.prop], f.typ);
      case $kindInterface:
        return searchJsObject(v.$val, v.constructor);
      default:
        return noJsObject;
      }
    };
    var o = searchJsObject(v, t);
    if (o !== noJsObject) {
      return o;
    }

    o = {};
    for (var i = 0; i < t.fields.length; i++) {
      var f = t.fields[i];
      if (!f.exported) {
        continue;
      }
      o[f.name] = $externalize(v[f.prop], f.typ);
    }
    return o;
  }
  $throwRuntimeError("cannot externalize " + t.string);
};

var $externalizeFunction = function(v, t, passThis) {
  if (v === $throwNilPointerError) {
    return null;
  }
  if (v.$externalizeWrapper === undefined) {
    $checkForDeadlock = false;
    v.$externalizeWrapper = function() {
      var args = [];
      for (var i = 0; i < t.params.length; i++) {
        if (t.variadic && i === t.params.length - 1) {
          var vt = t.params[i].elem, varargs = [];
          for (var j = i; j < arguments.length; j++) {
            varargs.push($internalize(arguments[j], vt));
          }
          args.push(new (t.params[i])(varargs));
          break;
        }
        args.push($internalize(arguments[i], t.params[i]));
      }
      var result = v.apply(passThis ? this : undefined, args);
      switch (t.results.length) {
      case 0:
        return;
      case 1:
        return $externalize(result, t.results[0]);
      default:
        for (var i = 0; i < t.results.length; i++) {
          result[i] = $externalize(result[i], t.results[i]);
        }
        return result;
      }
    };
  }
  return v.$externalizeWrapper;
};

var $internalize = function(v, t, recv, seen) {
  if (t === $jsObjectPtr) {
    return v;
  }
  if (t === $jsObjectPtr.elem) {
    $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
  }
  if (v && v.__internal_object__ !== undefined) {
    return $assertType(v.__internal_object__, t, false);
  }
  var timePkg = $packages["time"];
  if (timePkg !== undefined && t === timePkg.Time) {
    if (!(v !== null && v !== undefined && v.constructor === Date)) {
      $throwRuntimeError("cannot internalize time.Time from " + typeof v + ", must be Date");
    }
    return timePkg.Unix(new $Int64(0, 0), new $Int64(0, v.getTime() * 1000000));
  }

  // Cache for values we've already internalized in order to deal with circular
  // references.
  if (seen === undefined) { seen = new Map(); }
  if (!seen.has(t)) { seen.set(t, new Map()); }
  if (seen.get(t).has(v)) { return seen.get(t).get(v); }

  switch (t.kind) {
  case $kindBool:
    return !!v;
  case $kindInt:
    return parseInt(v);
  case $kindInt8:
    return parseInt(v) << 24 >> 24;
  case $kindInt16:
    return parseInt(v) << 16 >> 16;
  case $kindInt32:
    return parseInt(v) >> 0;
  case $kindUint:
    return parseInt(v);
  case $kindUint8:
    return parseInt(v) << 24 >>> 24;
  case $kindUint16:
    return parseInt(v) << 16 >>> 16;
  case $kindUint32:
  case $kindUintptr:
    return parseInt(v) >>> 0;
  case $kindInt64:
  case $kindUint64:
    return new t(0, v);
  case $kindFloat32:
  case $kindFloat64:
    return parseFloat(v);
  case $kindArray:
    if (v.length !== t.len) {
      $throwRuntimeError("got array with wrong size from JavaScript native");
    }
    return $mapArray(v, function(e) { return $internalize(e, t.elem); });
  case $kindFunc:
    return function() {
      var args = [];
      for (var i = 0; i < t.params.length; i++) {
        if (t.variadic && i === t.params.length - 1) {
          var vt = t.params[i].elem, varargs = arguments[i];
          for (var j = 0; j < varargs.$length; j++) {
            args.push($externalize(varargs.$array[varargs.$offset + j], vt));
          }
          break;
        }
        args.push($externalize(arguments[i], t.params[i]));
      }
      var result = v.apply(recv, args);
      switch (t.results.length) {
      case 0:
        return;
      case 1:
        return $internalize(result, t.results[0]);
      default:
        for (var i = 0; i < t.results.length; i++) {
          result[i] = $internalize(result[i], t.results[i]);
        }
        return result;
      }
    };
  case $kindInterface:
    if (t.methods.length !== 0) {
      $throwRuntimeError("cannot internalize " + t.string);
    }
    if (v === null) {
      return $ifaceNil;
    }
    if (v === undefined) {
      return new $jsObjectPtr(undefined);
    }
    switch (v.constructor) {
    case Int8Array:
      return new ($sliceType($Int8))(v);
    case Int16Array:
      return new ($sliceType($Int16))(v);
    case Int32Array:
      return new ($sliceType($Int))(v);
    case Uint8Array:
      return new ($sliceType($Uint8))(v);
    case Uint16Array:
      return new ($sliceType($Uint16))(v);
    case Uint32Array:
      return new ($sliceType($Uint))(v);
    case Float32Array:
      return new ($sliceType($Float32))(v);
    case Float64Array:
      return new ($sliceType($Float64))(v);
    case Array:
      return $internalize(v, $sliceType($emptyInterface));
    case Boolean:
      return new $Bool(!!v);
    case Date:
      if (timePkg === undefined) {
        /* time package is not present, internalize as &js.Object{Date} so it can be externalized into original Date. */
        return new $jsObjectPtr(v);
      }
      return new timePkg.Time($internalize(v, timePkg.Time));
    case (function () { }).constructor: // is usually Function, but in Chrome extensions it is something else
      var funcType = $funcType([$sliceType($emptyInterface)], [$jsObjectPtr], true);
      return new funcType($internalize(v, funcType));
    case Number:
      return new $Float64(parseFloat(v));
    case String:
      return new $String($internalize(v, $String));
    default:
      if ($global.Node && v instanceof $global.Node) {
        return new $jsObjectPtr(v);
      }
      var mapType = $mapType($String, $emptyInterface);
      return new mapType($internalize(v, mapType, recv, seen));
    }
  case $kindMap:
    var m = {};
    seen.get(t).set(v, m);
    var keys = $keys(v);
    for (var i = 0; i < keys.length; i++) {
      var k = $internalize(keys[i], t.key, recv, seen);
      m[t.key.keyFor(k)] = { k: k, v: $internalize(v[keys[i]], t.elem, recv, seen) };
    }
    return m;
  case $kindPtr:
    if (t.elem.kind === $kindStruct) {
      return $internalize(v, t.elem);
    }
  case $kindSlice:
    return new t($mapArray(v, function(e) { return $internalize(e, t.elem); }));
  case $kindString:
    v = String(v);
    if ($isASCII(v)) {
      return v;
    }
    var s = "";
    var i = 0;
    while (i < v.length) {
      var h = v.charCodeAt(i);
      if (0xD800 <= h && h <= 0xDBFF) {
        var l = v.charCodeAt(i + 1);
        var c = (h - 0xD800) * 0x400 + l - 0xDC00 + 0x10000;
        s += $encodeRune(c);
        i += 2;
        continue;
      }
      s += $encodeRune(h);
      i++;
    }
    return s;
  case $kindStruct:
    var noJsObject = {};
    var searchJsObject = function(t) {
      if (t === $jsObjectPtr) {
        return v;
      }
      if (t === $jsObjectPtr.elem) {
        $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
      }
      switch (t.kind) {
      case $kindPtr:
        return searchJsObject(t.elem);
      case $kindStruct:
        var f = t.fields[0];
        var o = searchJsObject(f.typ);
        if (o !== noJsObject) {
          var n = new t.ptr();
          n[f.prop] = o;
          return n;
        }
        return noJsObject;
      default:
        return noJsObject;
      }
    };
    var o = searchJsObject(t);
    if (o !== noJsObject) {
      return o;
    }
  }
  $throwRuntimeError("cannot internalize " + t.string);
};

/* $isASCII reports whether string s contains only ASCII characters. */
var $isASCII = function(s) {
  for (var i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 128) {
      return false;
    }
  }
  return true;
};

$packages["github.com/gopherjs/gopherjs/js"] = (function() {
	var $pkg = {}, $init, Object, Error, sliceType, ptrType, ptrType$1, MakeFunc, init;
	Object = $pkg.Object = $newType(0, $kindStruct, "js.Object", true, "github.com/gopherjs/gopherjs/js", true, function(object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.object = null;
			return;
		}
		this.object = object_;
	});
	Error = $pkg.Error = $newType(0, $kindStruct, "js.Error", true, "github.com/gopherjs/gopherjs/js", true, function(Object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Object = null;
			return;
		}
		this.Object = Object_;
	});
	sliceType = $sliceType($emptyInterface);
	ptrType = $ptrType(Object);
	ptrType$1 = $ptrType(Error);
	Object.ptr.prototype.Get = function(key) {
		var key, o;
		o = this;
		return o.object[$externalize(key, $String)];
	};
	Object.prototype.Get = function(key) { return this.$val.Get(key); };
	Object.ptr.prototype.Set = function(key, value) {
		var key, o, value;
		o = this;
		o.object[$externalize(key, $String)] = $externalize(value, $emptyInterface);
	};
	Object.prototype.Set = function(key, value) { return this.$val.Set(key, value); };
	Object.ptr.prototype.Delete = function(key) {
		var key, o;
		o = this;
		delete o.object[$externalize(key, $String)];
	};
	Object.prototype.Delete = function(key) { return this.$val.Delete(key); };
	Object.ptr.prototype.Length = function() {
		var o;
		o = this;
		return $parseInt(o.object.length);
	};
	Object.prototype.Length = function() { return this.$val.Length(); };
	Object.ptr.prototype.Index = function(i) {
		var i, o;
		o = this;
		return o.object[i];
	};
	Object.prototype.Index = function(i) { return this.$val.Index(i); };
	Object.ptr.prototype.SetIndex = function(i, value) {
		var i, o, value;
		o = this;
		o.object[i] = $externalize(value, $emptyInterface);
	};
	Object.prototype.SetIndex = function(i, value) { return this.$val.SetIndex(i, value); };
	Object.ptr.prototype.Call = function(name, args) {
		var args, name, o, obj;
		o = this;
		return (obj = o.object, obj[$externalize(name, $String)].apply(obj, $externalize(args, sliceType)));
	};
	Object.prototype.Call = function(name, args) { return this.$val.Call(name, args); };
	Object.ptr.prototype.Invoke = function(args) {
		var args, o;
		o = this;
		return o.object.apply(undefined, $externalize(args, sliceType));
	};
	Object.prototype.Invoke = function(args) { return this.$val.Invoke(args); };
	Object.ptr.prototype.New = function(args) {
		var args, o;
		o = this;
		return new ($global.Function.prototype.bind.apply(o.object, [undefined].concat($externalize(args, sliceType))));
	};
	Object.prototype.New = function(args) { return this.$val.New(args); };
	Object.ptr.prototype.Bool = function() {
		var o;
		o = this;
		return !!(o.object);
	};
	Object.prototype.Bool = function() { return this.$val.Bool(); };
	Object.ptr.prototype.String = function() {
		var o;
		o = this;
		return $internalize(o.object, $String);
	};
	Object.prototype.String = function() { return this.$val.String(); };
	Object.ptr.prototype.Int = function() {
		var o;
		o = this;
		return $parseInt(o.object) >> 0;
	};
	Object.prototype.Int = function() { return this.$val.Int(); };
	Object.ptr.prototype.Int64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Int64);
	};
	Object.prototype.Int64 = function() { return this.$val.Int64(); };
	Object.ptr.prototype.Uint64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Uint64);
	};
	Object.prototype.Uint64 = function() { return this.$val.Uint64(); };
	Object.ptr.prototype.Float = function() {
		var o;
		o = this;
		return $parseFloat(o.object);
	};
	Object.prototype.Float = function() { return this.$val.Float(); };
	Object.ptr.prototype.Interface = function() {
		var o;
		o = this;
		return $internalize(o.object, $emptyInterface);
	};
	Object.prototype.Interface = function() { return this.$val.Interface(); };
	Object.ptr.prototype.Unsafe = function() {
		var o;
		o = this;
		return o.object;
	};
	Object.prototype.Unsafe = function() { return this.$val.Unsafe(); };
	Error.ptr.prototype.Error = function() {
		var err;
		err = this;
		return "JavaScript error: " + $internalize(err.Object.message, $String);
	};
	Error.prototype.Error = function() { return this.$val.Error(); };
	Error.ptr.prototype.Stack = function() {
		var err;
		err = this;
		return $internalize(err.Object.stack, $String);
	};
	Error.prototype.Stack = function() { return this.$val.Stack(); };
	MakeFunc = function(fn) {
		var fn;
		return $makeFunc(fn);
	};
	$pkg.MakeFunc = MakeFunc;
	init = function() {
		var e;
		e = new Error.ptr(null);
		$unused(e);
	};
	ptrType.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [ptrType], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Length", name: "Length", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [ptrType], false)}, {prop: "SetIndex", name: "SetIndex", pkg: "", typ: $funcType([$Int, $emptyInterface], [], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType], [ptrType], true)}, {prop: "Invoke", name: "Invoke", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "New", name: "New", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Int64", name: "Int64", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "Uint64", name: "Uint64", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Interface", name: "Interface", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "Unsafe", name: "Unsafe", pkg: "", typ: $funcType([], [$Uintptr], false)}];
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Stack", name: "Stack", pkg: "", typ: $funcType([], [$String], false)}];
	Object.init("github.com/gopherjs/gopherjs/js", [{prop: "object", name: "object", embedded: false, exported: false, typ: ptrType, tag: ""}]);
	Error.init("", [{prop: "Object", name: "Object", embedded: true, exported: true, typ: ptrType, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["runtime/internal/sys"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["runtime"] = (function() {
	var $pkg = {}, $init, js, sys, _type, TypeAssertionError, errorString, ptrType$1, ptrType$2, buildVersion, init, throw$1;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	sys = $packages["runtime/internal/sys"];
	_type = $pkg._type = $newType(0, $kindStruct, "runtime._type", true, "runtime", false, function(str_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.str = "";
			return;
		}
		this.str = str_;
	});
	TypeAssertionError = $pkg.TypeAssertionError = $newType(0, $kindStruct, "runtime.TypeAssertionError", true, "runtime", true, function(_interface_, concrete_, asserted_, missingMethod_) {
		this.$val = this;
		if (arguments.length === 0) {
			this._interface = ptrType$1.nil;
			this.concrete = ptrType$1.nil;
			this.asserted = ptrType$1.nil;
			this.missingMethod = "";
			return;
		}
		this._interface = _interface_;
		this.concrete = concrete_;
		this.asserted = asserted_;
		this.missingMethod = missingMethod_;
	});
	errorString = $pkg.errorString = $newType(8, $kindString, "runtime.errorString", true, "runtime", false, null);
	ptrType$1 = $ptrType(_type);
	ptrType$2 = $ptrType(TypeAssertionError);
	_type.ptr.prototype.string = function() {
		var t;
		t = this;
		return t.str;
	};
	_type.prototype.string = function() { return this.$val.string(); };
	_type.ptr.prototype.pkgpath = function() {
		var t;
		t = this;
		return "";
	};
	_type.prototype.pkgpath = function() { return this.$val.pkgpath(); };
	TypeAssertionError.ptr.prototype.RuntimeError = function() {
	};
	TypeAssertionError.prototype.RuntimeError = function() { return this.$val.RuntimeError(); };
	TypeAssertionError.ptr.prototype.Error = function() {
		var as, cs, e, inter, msg;
		e = this;
		inter = "interface";
		if (!(e._interface === ptrType$1.nil)) {
			inter = e._interface.string();
		}
		as = e.asserted.string();
		if (e.concrete === ptrType$1.nil) {
			return "interface conversion: " + inter + " is nil, not " + as;
		}
		cs = e.concrete.string();
		if (e.missingMethod === "") {
			msg = "interface conversion: " + inter + " is " + cs + ", not " + as;
			if (cs === as) {
				if (!(e.concrete.pkgpath() === e.asserted.pkgpath())) {
					msg = msg + (" (types from different packages)");
				} else {
					msg = msg + (" (types from different scopes)");
				}
			}
			return msg;
		}
		return "interface conversion: " + cs + " is not " + as + ": missing method " + e.missingMethod;
	};
	TypeAssertionError.prototype.Error = function() { return this.$val.Error(); };
	init = function() {
		var e, jsPkg;
		jsPkg = $packages[$externalize("github.com/gopherjs/gopherjs/js", $String)];
		$jsObjectPtr = jsPkg.Object.ptr;
		$jsErrorPtr = jsPkg.Error.ptr;
		$throwRuntimeError = throw$1;
		buildVersion = $internalize($goVersion, $String);
		e = $ifaceNil;
		e = new TypeAssertionError.ptr(ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, "");
		$unused(e);
	};
	errorString.prototype.RuntimeError = function() {
		var e;
		e = this.$val;
	};
	$ptrType(errorString).prototype.RuntimeError = function() { return new errorString(this.$get()).RuntimeError(); };
	errorString.prototype.Error = function() {
		var e;
		e = this.$val;
		return "runtime error: " + (e);
	};
	$ptrType(errorString).prototype.Error = function() { return new errorString(this.$get()).Error(); };
	throw$1 = function(s) {
		var s;
		$panic(new errorString((s)));
	};
	ptrType$1.methods = [{prop: "string", name: "string", pkg: "runtime", typ: $funcType([], [$String], false)}, {prop: "pkgpath", name: "pkgpath", pkg: "runtime", typ: $funcType([], [$String], false)}];
	ptrType$2.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	_type.init("runtime", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	TypeAssertionError.init("runtime", [{prop: "_interface", name: "_interface", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "concrete", name: "concrete", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "asserted", name: "asserted", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "missingMethod", name: "missingMethod", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = sys.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buildVersion = "";
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/unsafeheader"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/reflectlite"] = (function() {
	var $pkg = {}, $init, js, unsafeheader, runtime, uncommonType, funcType, name, nameData, mapIter, TypeEx, errorString, Method, Type, Kind, tflag, rtype, method, chanDir, arrayType, chanType, imethod, interfaceType, mapType, ptrType, sliceType, structField, structType, nameOff, typeOff, textOff, Value, flag, ValueError, ptrType$1, sliceType$1, sliceType$2, sliceType$3, ptrType$2, funcType$1, sliceType$4, ptrType$3, sliceType$5, sliceType$6, sliceType$7, ptrType$4, ptrType$5, structType$2, sliceType$8, sliceType$9, ptrType$6, ptrType$7, sliceType$12, ptrType$8, ptrType$10, funcType$2, ptrType$11, funcType$3, ptrType$12, arrayType$2, sliceType$13, ptrType$13, initialized, uint8Type, idJsType, idReflectType, idKindType, idRtype, uncommonTypeMap, nameMap, nameOffList, typeOffList, jsObjectPtr, selectHelper, callHelper, kindNames, init, jsType, reflectType, setKindType, newName, newNameOff, newTypeOff, internalStr, isWrapped, copyStruct, makeValue, TypeOf, ValueOf, FuncOf, SliceOf, unsafe_New, typedmemmove, keyFor, mapaccess, mapiterinit, mapiterkey, mapiternext, maplen, methodReceiver, valueInterface, ifaceE2I, methodName, makeMethodValue, wrapJsObject, unwrapJsObject, getJsTag, PtrTo, copyVal, Swapper, unquote, implements$1, directlyAssignable, haveIdenticalType, haveIdenticalUnderlyingType, toType, ifaceIndir;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	unsafeheader = $packages["internal/unsafeheader"];
	runtime = $packages["runtime"];
	uncommonType = $pkg.uncommonType = $newType(0, $kindStruct, "reflectlite.uncommonType", true, "internal/reflectlite", false, function(pkgPath_, mcount_, xcount_, moff_, _methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.pkgPath = 0;
			this.mcount = 0;
			this.xcount = 0;
			this.moff = 0;
			this._methods = sliceType$5.nil;
			return;
		}
		this.pkgPath = pkgPath_;
		this.mcount = mcount_;
		this.xcount = xcount_;
		this.moff = moff_;
		this._methods = _methods_;
	});
	funcType = $pkg.funcType = $newType(0, $kindStruct, "reflectlite.funcType", true, "internal/reflectlite", false, function(rtype_, inCount_, outCount_, _in_, _out_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.inCount = 0;
			this.outCount = 0;
			this._in = sliceType$2.nil;
			this._out = sliceType$2.nil;
			return;
		}
		this.rtype = rtype_;
		this.inCount = inCount_;
		this.outCount = outCount_;
		this._in = _in_;
		this._out = _out_;
	});
	name = $pkg.name = $newType(0, $kindStruct, "reflectlite.name", true, "internal/reflectlite", false, function(bytes_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.bytes = ptrType$3.nil;
			return;
		}
		this.bytes = bytes_;
	});
	nameData = $pkg.nameData = $newType(0, $kindStruct, "reflectlite.nameData", true, "internal/reflectlite", false, function(name_, tag_, exported_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = "";
			this.tag = "";
			this.exported = false;
			return;
		}
		this.name = name_;
		this.tag = tag_;
		this.exported = exported_;
	});
	mapIter = $pkg.mapIter = $newType(0, $kindStruct, "reflectlite.mapIter", true, "internal/reflectlite", false, function(t_, m_, keys_, i_, last_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.t = $ifaceNil;
			this.m = null;
			this.keys = null;
			this.i = 0;
			this.last = null;
			return;
		}
		this.t = t_;
		this.m = m_;
		this.keys = keys_;
		this.i = i_;
		this.last = last_;
	});
	TypeEx = $pkg.TypeEx = $newType(8, $kindInterface, "reflectlite.TypeEx", true, "internal/reflectlite", true, null);
	errorString = $pkg.errorString = $newType(0, $kindStruct, "reflectlite.errorString", true, "internal/reflectlite", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	Method = $pkg.Method = $newType(0, $kindStruct, "reflectlite.Method", true, "internal/reflectlite", true, function(Name_, PkgPath_, Type_, Func_, Index_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.PkgPath = "";
			this.Type = $ifaceNil;
			this.Func = new Value.ptr(ptrType$1.nil, 0, 0);
			this.Index = 0;
			return;
		}
		this.Name = Name_;
		this.PkgPath = PkgPath_;
		this.Type = Type_;
		this.Func = Func_;
		this.Index = Index_;
	});
	Type = $pkg.Type = $newType(8, $kindInterface, "reflectlite.Type", true, "internal/reflectlite", true, null);
	Kind = $pkg.Kind = $newType(4, $kindUint, "reflectlite.Kind", true, "internal/reflectlite", true, null);
	tflag = $pkg.tflag = $newType(1, $kindUint8, "reflectlite.tflag", true, "internal/reflectlite", false, null);
	rtype = $pkg.rtype = $newType(0, $kindStruct, "reflectlite.rtype", true, "internal/reflectlite", false, function(size_, ptrdata_, hash_, tflag_, align_, fieldAlign_, kind_, equal_, gcdata_, str_, ptrToThis_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.size = 0;
			this.ptrdata = 0;
			this.hash = 0;
			this.tflag = 0;
			this.align = 0;
			this.fieldAlign = 0;
			this.kind = 0;
			this.equal = $throwNilPointerError;
			this.gcdata = ptrType$3.nil;
			this.str = 0;
			this.ptrToThis = 0;
			return;
		}
		this.size = size_;
		this.ptrdata = ptrdata_;
		this.hash = hash_;
		this.tflag = tflag_;
		this.align = align_;
		this.fieldAlign = fieldAlign_;
		this.kind = kind_;
		this.equal = equal_;
		this.gcdata = gcdata_;
		this.str = str_;
		this.ptrToThis = ptrToThis_;
	});
	method = $pkg.method = $newType(0, $kindStruct, "reflectlite.method", true, "internal/reflectlite", false, function(name_, mtyp_, ifn_, tfn_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.mtyp = 0;
			this.ifn = 0;
			this.tfn = 0;
			return;
		}
		this.name = name_;
		this.mtyp = mtyp_;
		this.ifn = ifn_;
		this.tfn = tfn_;
	});
	chanDir = $pkg.chanDir = $newType(4, $kindInt, "reflectlite.chanDir", true, "internal/reflectlite", false, null);
	arrayType = $pkg.arrayType = $newType(0, $kindStruct, "reflectlite.arrayType", true, "internal/reflectlite", false, function(rtype_, elem_, slice_, len_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.slice = ptrType$1.nil;
			this.len = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.slice = slice_;
		this.len = len_;
	});
	chanType = $pkg.chanType = $newType(0, $kindStruct, "reflectlite.chanType", true, "internal/reflectlite", false, function(rtype_, elem_, dir_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.dir = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.dir = dir_;
	});
	imethod = $pkg.imethod = $newType(0, $kindStruct, "reflectlite.imethod", true, "internal/reflectlite", false, function(name_, typ_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.typ = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
	});
	interfaceType = $pkg.interfaceType = $newType(0, $kindStruct, "reflectlite.interfaceType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$3.nil);
			this.methods = sliceType$6.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.methods = methods_;
	});
	mapType = $pkg.mapType = $newType(0, $kindStruct, "reflectlite.mapType", true, "internal/reflectlite", false, function(rtype_, key_, elem_, bucket_, hasher_, keysize_, valuesize_, bucketsize_, flags_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.key = ptrType$1.nil;
			this.elem = ptrType$1.nil;
			this.bucket = ptrType$1.nil;
			this.hasher = $throwNilPointerError;
			this.keysize = 0;
			this.valuesize = 0;
			this.bucketsize = 0;
			this.flags = 0;
			return;
		}
		this.rtype = rtype_;
		this.key = key_;
		this.elem = elem_;
		this.bucket = bucket_;
		this.hasher = hasher_;
		this.keysize = keysize_;
		this.valuesize = valuesize_;
		this.bucketsize = bucketsize_;
		this.flags = flags_;
	});
	ptrType = $pkg.ptrType = $newType(0, $kindStruct, "reflectlite.ptrType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	sliceType = $pkg.sliceType = $newType(0, $kindStruct, "reflectlite.sliceType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	structField = $pkg.structField = $newType(0, $kindStruct, "reflectlite.structField", true, "internal/reflectlite", false, function(name_, typ_, offsetEmbed_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = new name.ptr(ptrType$3.nil);
			this.typ = ptrType$1.nil;
			this.offsetEmbed = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
		this.offsetEmbed = offsetEmbed_;
	});
	structType = $pkg.structType = $newType(0, $kindStruct, "reflectlite.structType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, fields_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$3.nil);
			this.fields = sliceType$7.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.fields = fields_;
	});
	nameOff = $pkg.nameOff = $newType(4, $kindInt32, "reflectlite.nameOff", true, "internal/reflectlite", false, null);
	typeOff = $pkg.typeOff = $newType(4, $kindInt32, "reflectlite.typeOff", true, "internal/reflectlite", false, null);
	textOff = $pkg.textOff = $newType(4, $kindInt32, "reflectlite.textOff", true, "internal/reflectlite", false, null);
	Value = $pkg.Value = $newType(0, $kindStruct, "reflectlite.Value", true, "internal/reflectlite", true, function(typ_, ptr_, flag_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.typ = ptrType$1.nil;
			this.ptr = 0;
			this.flag = 0;
			return;
		}
		this.typ = typ_;
		this.ptr = ptr_;
		this.flag = flag_;
	});
	flag = $pkg.flag = $newType(4, $kindUintptr, "reflectlite.flag", true, "internal/reflectlite", false, null);
	ValueError = $pkg.ValueError = $newType(0, $kindStruct, "reflectlite.ValueError", true, "internal/reflectlite", true, function(Method_, Kind_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Method = "";
			this.Kind = 0;
			return;
		}
		this.Method = Method_;
		this.Kind = Kind_;
	});
	ptrType$1 = $ptrType(rtype);
	sliceType$1 = $sliceType(name);
	sliceType$2 = $sliceType(ptrType$1);
	sliceType$3 = $sliceType($emptyInterface);
	ptrType$2 = $ptrType(js.Object);
	funcType$1 = $funcType([sliceType$3], [ptrType$2], true);
	sliceType$4 = $sliceType($String);
	ptrType$3 = $ptrType($Uint8);
	sliceType$5 = $sliceType(method);
	sliceType$6 = $sliceType(imethod);
	sliceType$7 = $sliceType(structField);
	ptrType$4 = $ptrType(uncommonType);
	ptrType$5 = $ptrType(nameData);
	structType$2 = $structType("internal/reflectlite", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	sliceType$8 = $sliceType(ptrType$2);
	sliceType$9 = $sliceType(Value);
	ptrType$6 = $ptrType(mapIter);
	ptrType$7 = $ptrType(funcType);
	sliceType$12 = $sliceType(Type);
	ptrType$8 = $ptrType($UnsafePointer);
	ptrType$10 = $ptrType(errorString);
	funcType$2 = $funcType([$UnsafePointer, $UnsafePointer], [$Bool], false);
	ptrType$11 = $ptrType(interfaceType);
	funcType$3 = $funcType([$UnsafePointer, $Uintptr], [$Uintptr], false);
	ptrType$12 = $ptrType(structField);
	arrayType$2 = $arrayType($Uintptr, 2);
	sliceType$13 = $sliceType($Uint8);
	ptrType$13 = $ptrType(ValueError);
	init = function() {
		var used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; used = $f.used; x = $f.x; x$1 = $f.x$1; x$10 = $f.x$10; x$11 = $f.x$11; x$12 = $f.x$12; x$2 = $f.x$2; x$3 = $f.x$3; x$4 = $f.x$4; x$5 = $f.x$5; x$6 = $f.x$6; x$7 = $f.x$7; x$8 = $f.x$8; x$9 = $f.x$9; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		used = (function(i) {
			var i;
		});
		$r = used((x = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), new x.constructor.elem(x))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$1 = new uncommonType.ptr(0, 0, 0, 0, sliceType$5.nil), new x$1.constructor.elem(x$1))); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$2 = new method.ptr(0, 0, 0, 0), new x$2.constructor.elem(x$2))); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$3 = new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, 0), new x$3.constructor.elem(x$3))); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$4 = new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), ptrType$1.nil, 0), new x$4.constructor.elem(x$4))); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$5 = new funcType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), 0, 0, sliceType$2.nil, sliceType$2.nil), new x$5.constructor.elem(x$5))); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$6 = new interfaceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), new name.ptr(ptrType$3.nil), sliceType$6.nil), new x$6.constructor.elem(x$6))); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$7 = new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0), new x$7.constructor.elem(x$7))); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$8 = new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), ptrType$1.nil), new x$8.constructor.elem(x$8))); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$9 = new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), ptrType$1.nil), new x$9.constructor.elem(x$9))); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$10 = new structType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), new name.ptr(ptrType$3.nil), sliceType$7.nil), new x$10.constructor.elem(x$10))); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$11 = new imethod.ptr(0, 0), new x$11.constructor.elem(x$11))); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$12 = new structField.ptr(new name.ptr(ptrType$3.nil), ptrType$1.nil, 0), new x$12.constructor.elem(x$12))); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		initialized = true;
		uint8Type = $assertType(TypeOf(new $Uint8(0)), ptrType$1);
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: init }; } $f.used = used; $f.x = x; $f.x$1 = x$1; $f.x$10 = x$10; $f.x$11 = x$11; $f.x$12 = x$12; $f.x$2 = x$2; $f.x$3 = x$3; $f.x$4 = x$4; $f.x$5 = x$5; $f.x$6 = x$6; $f.x$7 = x$7; $f.x$8 = x$8; $f.x$9 = x$9; $f.$s = $s; $f.$r = $r; return $f;
	};
	jsType = function(typ) {
		var typ;
		return typ[$externalize(idJsType, $String)];
	};
	reflectType = function(typ) {
		var _1, _i, _i$1, _i$2, _i$3, _key, _ref, _ref$1, _ref$2, _ref$3, dir, exported, exported$1, f, fields, i, i$1, i$2, i$3, i$4, i$5, imethods, in$1, m, m$1, m$2, methodSet, methods, offsetEmbed, out, outCount, params, reflectFields, reflectMethods, results, rt, typ, ut, xcount;
		if (typ[$externalize(idReflectType, $String)] === undefined) {
			rt = new rtype.ptr(((($parseInt(typ.size) >> 0) >>> 0)), 0, 0, 0, 0, 0, ((($parseInt(typ.kind) >> 0) << 24 >>> 24)), $throwNilPointerError, ptrType$3.nil, newNameOff($clone(newName(internalStr(typ.string), "", !!(typ.exported)), name)), 0);
			rt[$externalize(idJsType, $String)] = typ;
			typ[$externalize(idReflectType, $String)] = rt;
			methodSet = $methodSet(typ);
			if (!(($parseInt(methodSet.length) === 0)) || !!(typ.named)) {
				rt.tflag = (rt.tflag | (1)) >>> 0;
				if (!!(typ.named)) {
					rt.tflag = (rt.tflag | (4)) >>> 0;
				}
				reflectMethods = sliceType$5.nil;
				i = 0;
				while (true) {
					if (!(i < $parseInt(methodSet.length))) { break; }
					m = methodSet[i];
					exported = internalStr(m.pkg) === "";
					if (!exported) {
						i = i + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m.name), "", exported), name)), newTypeOff(reflectType(m.typ)), 0, 0));
					i = i + (1) >> 0;
				}
				xcount = ((reflectMethods.$length << 16 >>> 16));
				i$1 = 0;
				while (true) {
					if (!(i$1 < $parseInt(methodSet.length))) { break; }
					m$1 = methodSet[i$1];
					exported$1 = internalStr(m$1.pkg) === "";
					if (exported$1) {
						i$1 = i$1 + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m$1.name), "", exported$1), name)), newTypeOff(reflectType(m$1.typ)), 0, 0));
					i$1 = i$1 + (1) >> 0;
				}
				ut = new uncommonType.ptr(newNameOff($clone(newName(internalStr(typ.pkg), "", false), name)), (($parseInt(methodSet.length) << 16 >>> 16)), xcount, 0, reflectMethods);
				_key = rt; (uncommonTypeMap || $throwRuntimeError("assignment to entry in nil map"))[ptrType$1.keyFor(_key)] = { k: _key, v: ut };
				ut[$externalize(idJsType, $String)] = typ;
			}
			_1 = rt.Kind();
			if (_1 === (17)) {
				setKindType(rt, new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), reflectType(typ.elem), ptrType$1.nil, ((($parseInt(typ.len) >> 0) >>> 0))));
			} else if (_1 === (18)) {
				dir = 3;
				if (!!(typ.sendOnly)) {
					dir = 2;
				}
				if (!!(typ.recvOnly)) {
					dir = 1;
				}
				setKindType(rt, new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), reflectType(typ.elem), ((dir >>> 0))));
			} else if (_1 === (19)) {
				params = typ.params;
				in$1 = $makeSlice(sliceType$2, $parseInt(params.length));
				_ref = in$1;
				_i = 0;
				while (true) {
					if (!(_i < _ref.$length)) { break; }
					i$2 = _i;
					((i$2 < 0 || i$2 >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + i$2] = reflectType(params[i$2]));
					_i++;
				}
				results = typ.results;
				out = $makeSlice(sliceType$2, $parseInt(results.length));
				_ref$1 = out;
				_i$1 = 0;
				while (true) {
					if (!(_i$1 < _ref$1.$length)) { break; }
					i$3 = _i$1;
					((i$3 < 0 || i$3 >= out.$length) ? ($throwRuntimeError("index out of range"), undefined) : out.$array[out.$offset + i$3] = reflectType(results[i$3]));
					_i$1++;
				}
				outCount = (($parseInt(results.length) << 16 >>> 16));
				if (!!(typ.variadic)) {
					outCount = (outCount | (32768)) >>> 0;
				}
				setKindType(rt, new funcType.ptr($clone(rt, rtype), (($parseInt(params.length) << 16 >>> 16)), outCount, in$1, out));
			} else if (_1 === (20)) {
				methods = typ.methods;
				imethods = $makeSlice(sliceType$6, $parseInt(methods.length));
				_ref$2 = imethods;
				_i$2 = 0;
				while (true) {
					if (!(_i$2 < _ref$2.$length)) { break; }
					i$4 = _i$2;
					m$2 = methods[i$4];
					imethod.copy(((i$4 < 0 || i$4 >= imethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : imethods.$array[imethods.$offset + i$4]), new imethod.ptr(newNameOff($clone(newName(internalStr(m$2.name), "", internalStr(m$2.pkg) === ""), name)), newTypeOff(reflectType(m$2.typ))));
					_i$2++;
				}
				setKindType(rt, new interfaceType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkg), "", false), name), imethods));
			} else if (_1 === (21)) {
				setKindType(rt, new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), reflectType(typ.key), reflectType(typ.elem), ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0));
			} else if (_1 === (22)) {
				setKindType(rt, new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (23)) {
				setKindType(rt, new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (25)) {
				fields = typ.fields;
				reflectFields = $makeSlice(sliceType$7, $parseInt(fields.length));
				_ref$3 = reflectFields;
				_i$3 = 0;
				while (true) {
					if (!(_i$3 < _ref$3.$length)) { break; }
					i$5 = _i$3;
					f = fields[i$5];
					offsetEmbed = ((i$5 >>> 0)) << 1 >>> 0;
					if (!!(f.embedded)) {
						offsetEmbed = (offsetEmbed | (1)) >>> 0;
					}
					structField.copy(((i$5 < 0 || i$5 >= reflectFields.$length) ? ($throwRuntimeError("index out of range"), undefined) : reflectFields.$array[reflectFields.$offset + i$5]), new structField.ptr($clone(newName(internalStr(f.name), internalStr(f.tag), !!(f.exported)), name), reflectType(f.typ), offsetEmbed));
					_i$3++;
				}
				setKindType(rt, new structType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkgPath), "", false), name), reflectFields));
			}
		}
		return ((typ[$externalize(idReflectType, $String)]));
	};
	setKindType = function(rt, kindType) {
		var kindType, rt;
		rt[$externalize(idKindType, $String)] = kindType;
		kindType[$externalize(idRtype, $String)] = rt;
	};
	uncommonType.ptr.prototype.methods = function() {
		var t;
		t = this;
		return t._methods;
	};
	uncommonType.prototype.methods = function() { return this.$val.methods(); };
	uncommonType.ptr.prototype.exportedMethods = function() {
		var t;
		t = this;
		return $subslice(t._methods, 0, t.xcount, t.xcount);
	};
	uncommonType.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.uncommon = function() {
		var _entry, t;
		t = this;
		return (_entry = uncommonTypeMap[ptrType$1.keyFor(t)], _entry !== undefined ? _entry.v : ptrType$4.nil);
	};
	rtype.prototype.uncommon = function() { return this.$val.uncommon(); };
	funcType.ptr.prototype.in$ = function() {
		var t;
		t = this;
		return t._in;
	};
	funcType.prototype.in$ = function() { return this.$val.in$(); };
	funcType.ptr.prototype.out = function() {
		var t;
		t = this;
		return t._out;
	};
	funcType.prototype.out = function() { return this.$val.out(); };
	name.ptr.prototype.name = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = nameMap[ptrType$3.keyFor(n.bytes)], _entry !== undefined ? _entry.v : ptrType$5.nil).name;
		return s;
	};
	name.prototype.name = function() { return this.$val.name(); };
	name.ptr.prototype.tag = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = nameMap[ptrType$3.keyFor(n.bytes)], _entry !== undefined ? _entry.v : ptrType$5.nil).tag;
		return s;
	};
	name.prototype.tag = function() { return this.$val.tag(); };
	name.ptr.prototype.pkgPath = function() {
		var n;
		n = this;
		return "";
	};
	name.prototype.pkgPath = function() { return this.$val.pkgPath(); };
	name.ptr.prototype.isExported = function() {
		var _entry, n;
		n = this;
		return (_entry = nameMap[ptrType$3.keyFor(n.bytes)], _entry !== undefined ? _entry.v : ptrType$5.nil).exported;
	};
	name.prototype.isExported = function() { return this.$val.isExported(); };
	newName = function(n, tag, exported) {
		var _key, b, exported, n, tag;
		b = $newDataPointer(0, ptrType$3);
		_key = b; (nameMap || $throwRuntimeError("assignment to entry in nil map"))[ptrType$3.keyFor(_key)] = { k: _key, v: new nameData.ptr(n, tag, exported) };
		return new name.ptr(b);
	};
	rtype.ptr.prototype.nameOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= nameOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : nameOffList.$array[nameOffList.$offset + x]));
	};
	rtype.prototype.nameOff = function(off) { return this.$val.nameOff(off); };
	newNameOff = function(n) {
		var i, n;
		i = nameOffList.$length;
		nameOffList = $append(nameOffList, n);
		return ((i >> 0));
	};
	rtype.ptr.prototype.typeOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= typeOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : typeOffList.$array[typeOffList.$offset + x]));
	};
	rtype.prototype.typeOff = function(off) { return this.$val.typeOff(off); };
	newTypeOff = function(t) {
		var i, t;
		i = typeOffList.$length;
		typeOffList = $append(typeOffList, t);
		return ((i >> 0));
	};
	internalStr = function(strObj) {
		var c, strObj;
		c = new structType$2.ptr("");
		c.str = strObj;
		return c.str;
	};
	isWrapped = function(typ) {
		var typ;
		return !!(jsType(typ).wrapped);
	};
	copyStruct = function(dst, src, typ) {
		var dst, fields, i, prop, src, typ;
		fields = jsType(typ).fields;
		i = 0;
		while (true) {
			if (!(i < $parseInt(fields.length))) { break; }
			prop = $internalize(fields[i].prop, $String);
			dst[$externalize(prop, $String)] = src[$externalize(prop, $String)];
			i = i + (1) >> 0;
		}
	};
	makeValue = function(t, v, fl) {
		var $24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; $24r$1 = $f.$24r$1; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; _r$3 = $f._r$3; _r$4 = $f._r$4; _r$5 = $f._r$5; _v = $f._v; _v$1 = $f._v$1; fl = $f.fl; rt = $f.rt; t = $f.t; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rt = _r;
		_r$1 = t.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (_r$1 === 17) { _v$1 = true; $s = 5; continue s; }
		_r$2 = t.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_v$1 = _r$2 === 25; case 5:
		if (_v$1) { _v = true; $s = 4; continue s; }
		_r$3 = t.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = _r$3 === 22; case 4:
		/* */ if (_v) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (_v) { */ case 2:
			_r$4 = t.Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			$24r = new Value.ptr(rt, (v), (fl | ((_r$4 >>> 0))) >>> 0);
			$s = 10; case 10: return $24r;
		/* } */ case 3:
		_r$5 = t.Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		$24r$1 = new Value.ptr(rt, ($newDataPointer(v, jsType(rt.ptrTo()))), (((fl | ((_r$5 >>> 0))) >>> 0) | 128) >>> 0);
		$s = 12; case 12: return $24r$1;
		/* */ } return; } if ($f === undefined) { $f = { $blk: makeValue }; } $f.$24r = $24r; $f.$24r$1 = $24r$1; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f._r$3 = _r$3; $f._r$4 = _r$4; $f._r$5 = _r$5; $f._v = _v; $f._v$1 = _v$1; $f.fl = fl; $f.rt = rt; $f.t = t; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	TypeOf = function(i) {
		var i;
		if (!initialized) {
			return new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$3.nil, 0, 0);
		}
		if ($interfaceIsEqual(i, $ifaceNil)) {
			return $ifaceNil;
		}
		return reflectType(i.constructor);
	};
	$pkg.TypeOf = TypeOf;
	ValueOf = function(i) {
		var $24r, _r, i, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; i = $f.i; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(i, $ifaceNil)) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		_r = makeValue(reflectType(i.constructor), i.$val, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: ValueOf }; } $f.$24r = $24r; $f._r = _r; $f.i = i; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.ValueOf = ValueOf;
	FuncOf = function(in$1, out, variadic) {
		var _i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _i = $f._i; _i$1 = $f._i$1; _r = $f._r; _ref = $f._ref; _ref$1 = $f._ref$1; _v = $f._v; _v$1 = $f._v$1; i = $f.i; i$1 = $f.i$1; in$1 = $f.in$1; jsIn = $f.jsIn; jsOut = $f.jsOut; out = $f.out; v = $f.v; v$1 = $f.v$1; variadic = $f.variadic; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		if (!(variadic)) { _v = false; $s = 3; continue s; }
		if (in$1.$length === 0) { _v$1 = true; $s = 4; continue s; }
		_r = (x = in$1.$length - 1 >> 0, ((x < 0 || x >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + x])).Kind(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v$1 = !((_r === 23)); case 4:
		_v = _v$1; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$panic(new $String("reflect.FuncOf: last arg of variadic func must be slice"));
		/* } */ case 2:
		jsIn = $makeSlice(sliceType$8, in$1.$length);
		_ref = in$1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= jsIn.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsIn.$array[jsIn.$offset + i] = jsType(v));
			_i++;
		}
		jsOut = $makeSlice(sliceType$8, out.$length);
		_ref$1 = out;
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			i$1 = _i$1;
			v$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			((i$1 < 0 || i$1 >= jsOut.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsOut.$array[jsOut.$offset + i$1] = jsType(v$1));
			_i$1++;
		}
		$s = -1; return reflectType($funcType($externalize(jsIn, sliceType$8), $externalize(jsOut, sliceType$8), $externalize(variadic, $Bool)));
		/* */ } return; } if ($f === undefined) { $f = { $blk: FuncOf }; } $f._i = _i; $f._i$1 = _i$1; $f._r = _r; $f._ref = _ref; $f._ref$1 = _ref$1; $f._v = _v; $f._v$1 = _v$1; $f.i = i; $f.i$1 = i$1; $f.in$1 = in$1; $f.jsIn = jsIn; $f.jsOut = jsOut; $f.out = out; $f.v = v; $f.v$1 = v$1; $f.variadic = variadic; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.FuncOf = FuncOf;
	rtype.ptr.prototype.ptrTo = function() {
		var t;
		t = this;
		return reflectType($ptrType(jsType(t)));
	};
	rtype.prototype.ptrTo = function() { return this.$val.ptrTo(); };
	SliceOf = function(t) {
		var t;
		return reflectType($sliceType(jsType(t)));
	};
	$pkg.SliceOf = SliceOf;
	unsafe_New = function(typ) {
		var _1, typ;
		_1 = typ.Kind();
		if (_1 === (25)) {
			return (new (jsType(typ).ptr)());
		} else if (_1 === (17)) {
			return (jsType(typ).zero());
		} else {
			return ($newDataPointer(jsType(typ).zero(), jsType(typ.ptrTo())));
		}
	};
	typedmemmove = function(t, dst, src) {
		var dst, src, t;
		dst.$set(src.$get());
	};
	keyFor = function(t, key) {
		var k, key, kv, t;
		kv = key;
		if (!(kv.$get === undefined)) {
			kv = kv.$get();
		}
		k = $internalize(jsType(t.Key()).keyFor(kv), $String);
		return [kv, k];
	};
	mapaccess = function(t, m, key) {
		var _tuple, entry, k, key, m, t;
		_tuple = keyFor(t, key);
		k = _tuple[1];
		entry = m[$externalize(k, $String)];
		if (entry === undefined) {
			return 0;
		}
		return ($newDataPointer(entry.v, jsType(PtrTo(t.Elem()))));
	};
	mapIter.ptr.prototype.skipUntilValidKey = function() {
		var iter, k;
		iter = this;
		while (true) {
			if (!(iter.i < $parseInt(iter.keys.length))) { break; }
			k = iter.keys[iter.i];
			if (!(iter.m[$externalize($internalize(k, $String), $String)] === undefined)) {
				break;
			}
			iter.i = iter.i + (1) >> 0;
		}
	};
	mapIter.prototype.skipUntilValidKey = function() { return this.$val.skipUntilValidKey(); };
	mapiterinit = function(t, m) {
		var m, t;
		return (new mapIter.ptr(t, m, $keys(m), 0, null));
	};
	mapiterkey = function(it) {
		var $24r, _r, _r$1, _r$2, it, iter, k, kv, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; it = $f.it; iter = $f.iter; k = $f.k; kv = $f.kv; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		iter = ($pointerOfStructConversion(it, ptrType$6));
		kv = null;
		if (!(iter.last === null)) {
			kv = iter.last;
		} else {
			iter.skipUntilValidKey();
			if (iter.i === $parseInt(iter.keys.length)) {
				$s = -1; return 0;
			}
			k = iter.keys[iter.i];
			kv = iter.m[$externalize($internalize(k, $String), $String)];
			iter.last = kv;
		}
		_r = $assertType(iter.t, TypeEx).Key(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = PtrTo(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = jsType(_r$1); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = ($newDataPointer(kv.k, _r$2));
		$s = 4; case 4: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: mapiterkey }; } $f.$24r = $24r; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f.it = it; $f.iter = iter; $f.k = k; $f.kv = kv; $f.$s = $s; $f.$r = $r; return $f;
	};
	mapiternext = function(it) {
		var it, iter;
		iter = ($pointerOfStructConversion(it, ptrType$6));
		iter.last = null;
		iter.i = iter.i + (1) >> 0;
	};
	maplen = function(m) {
		var m;
		return $parseInt($keys(m).length);
	};
	methodReceiver = function(op, v, i) {
		var _$12, fn, i, m, m$1, ms, op, prop, rcvr, t, tt, v, x;
		_$12 = ptrType$1.nil;
		t = ptrType$7.nil;
		fn = 0;
		prop = "";
		if (v.typ.Kind() === 20) {
			tt = (v.typ.kindType);
			if (i < 0 || i >= tt.methods.$length) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m = (x = tt.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			if (!$clone(tt.rtype.nameOff(m.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (tt.rtype.typeOff(m.typ).kindType);
			prop = $clone(tt.rtype.nameOff(m.name), name).name();
		} else {
			ms = v.typ.exportedMethods();
			if (((i >>> 0)) >= ((ms.$length >>> 0))) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m$1 = $clone(((i < 0 || i >= ms.$length) ? ($throwRuntimeError("index out of range"), undefined) : ms.$array[ms.$offset + i]), method);
			if (!$clone(v.typ.nameOff(m$1.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (v.typ.typeOff(m$1.mtyp).kindType);
			prop = $internalize($methodSet(jsType(v.typ))[i].prop, $String);
		}
		rcvr = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr = new (jsType(v.typ))(rcvr);
		}
		fn = (rcvr[$externalize(prop, $String)]);
		return [_$12, t, fn];
	};
	valueInterface = function(v) {
		var _r, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.Interface", 0));
		}
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue("Interface", $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
		if (isWrapped(v.typ)) {
			$s = -1; return ((new (jsType(v.typ))($clone(v, Value).object())));
		}
		$s = -1; return (($clone(v, Value).object()));
		/* */ } return; } if ($f === undefined) { $f = { $blk: valueInterface }; } $f._r = _r; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	ifaceE2I = function(t, src, dst) {
		var dst, src, t;
		dst.$set(src);
	};
	methodName = function() {
		return "?FIXME?";
	};
	makeMethodValue = function(op, v) {
		var $24r, _r, _tuple, fn, fv, op, rcvr, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; _tuple = $f._tuple; fn = $f.fn; fv = $f.fv; op = $f.op; rcvr = $f.rcvr; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		fn = [fn];
		rcvr = [rcvr];
		if (((v.flag & 512) >>> 0) === 0) {
			$panic(new $String("reflect: internal error: invalid use of makePartialFunc"));
		}
		_tuple = methodReceiver(op, $clone(v, Value), ((v.flag >> 0)) >> 10 >> 0);
		fn[0] = _tuple[2];
		rcvr[0] = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr[0] = new (jsType(v.typ))(rcvr[0]);
		}
		fv = js.MakeFunc((function(fn, rcvr) { return function(this$1, arguments$1) {
			var arguments$1, this$1;
			return new $jsObjectPtr(fn[0].apply(rcvr[0], $externalize(arguments$1, sliceType$8)));
		}; })(fn, rcvr));
		_r = $clone(v, Value).Type().common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r, (fv), (new flag(v.flag).ro() | 19) >>> 0);
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: makeMethodValue }; } $f.$24r = $24r; $f._r = _r; $f._tuple = _tuple; $f.fn = fn; $f.fv = fv; $f.op = op; $f.rcvr = rcvr; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	wrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return new (jsType(jsObjectPtr))(val);
		}
		return val;
	};
	unwrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return val.object;
		}
		return val;
	};
	getJsTag = function(tag) {
		var _tuple, i, name$1, qvalue, tag, value;
		while (true) {
			if (!(!(tag === ""))) { break; }
			i = 0;
			while (true) {
				if (!(i < tag.length && (tag.charCodeAt(i) === 32))) { break; }
				i = i + (1) >> 0;
			}
			tag = $substring(tag, i);
			if (tag === "") {
				break;
			}
			i = 0;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 32)) && !((tag.charCodeAt(i) === 58)) && !((tag.charCodeAt(i) === 34)))) { break; }
				i = i + (1) >> 0;
			}
			if ((i + 1 >> 0) >= tag.length || !((tag.charCodeAt(i) === 58)) || !((tag.charCodeAt((i + 1 >> 0)) === 34))) {
				break;
			}
			name$1 = ($substring(tag, 0, i));
			tag = $substring(tag, (i + 1 >> 0));
			i = 1;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 34)))) { break; }
				if (tag.charCodeAt(i) === 92) {
					i = i + (1) >> 0;
				}
				i = i + (1) >> 0;
			}
			if (i >= tag.length) {
				break;
			}
			qvalue = ($substring(tag, 0, (i + 1 >> 0)));
			tag = $substring(tag, (i + 1 >> 0));
			if (name$1 === "js") {
				_tuple = unquote(qvalue);
				value = _tuple[0];
				return value;
			}
		}
		return "";
	};
	PtrTo = function(t) {
		var t;
		return $assertType(t, ptrType$1).ptrTo();
	};
	$pkg.PtrTo = PtrTo;
	copyVal = function(typ, fl, ptr) {
		var c, fl, ptr, typ;
		if (ifaceIndir(typ)) {
			c = unsafe_New(typ);
			typedmemmove(typ, c, ptr);
			return new Value.ptr(typ, c, (fl | 128) >>> 0);
		}
		return new Value.ptr(typ, (ptr).$get(), fl);
	};
	Swapper = function(slice) {
		var _1, _r, a, off, slice, v, vLen, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _1 = $f._1; _r = $f._r; a = $f.a; off = $f.off; slice = $f.slice; v = $f.v; vLen = $f.vLen; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		a = [a];
		off = [off];
		vLen = [vLen];
		_r = ValueOf(slice); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		v = $clone(_r, Value);
		if (!(($clone(v, Value).Kind() === 23))) {
			$panic(new ValueError.ptr("Swapper", $clone(v, Value).Kind()));
		}
		vLen[0] = (($clone(v, Value).Len() >>> 0));
		_1 = vLen[0];
		if (_1 === (0)) {
			$s = -1; return (function(a, off, vLen) { return function(i, j) {
				var i, j;
				$panic(new $String("reflect: slice index out of range"));
			}; })(a, off, vLen);
		} else if (_1 === (1)) {
			$s = -1; return (function(a, off, vLen) { return function(i, j) {
				var i, j;
				if (!((i === 0)) || !((j === 0))) {
					$panic(new $String("reflect: slice index out of range"));
				}
			}; })(a, off, vLen);
		}
		a[0] = slice.$array;
		off[0] = $parseInt(slice.$offset) >> 0;
		$s = -1; return (function(a, off, vLen) { return function(i, j) {
			var i, j, tmp;
			if (((i >>> 0)) >= vLen[0] || ((j >>> 0)) >= vLen[0]) {
				$panic(new $String("reflect: slice index out of range"));
			}
			i = i + (off[0]) >> 0;
			j = j + (off[0]) >> 0;
			tmp = a[0][i];
			a[0][i] = a[0][j];
			a[0][j] = tmp;
		}; })(a, off, vLen);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Swapper }; } $f._1 = _1; $f._r = _r; $f.a = a; $f.off = off; $f.slice = slice; $f.v = v; $f.vLen = vLen; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.Swapper = Swapper;
	rtype.ptr.prototype.Comparable = function() {
		var $24r, _1, _r, _r$1, ft, i, t, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _1 = $f._1; _r = $f._r; _r$1 = $f._r$1; ft = $f.ft; i = $f.i; t = $f.t; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		t = this;
			_1 = t.Kind();
			/* */ if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { $s = 2; continue; }
			/* */ if (_1 === (17)) { $s = 3; continue; }
			/* */ if (_1 === (25)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { */ case 2:
				$s = -1; return false;
			/* } else if (_1 === (17)) { */ case 3:
				_r = t.Elem().Comparable(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (25)) { */ case 4:
				i = 0;
				/* while (true) { */ case 8:
					/* if (!(i < t.NumField())) { break; } */ if(!(i < t.NumField())) { $s = 9; continue; }
					ft = $clone(t.Field(i), structField);
					_r$1 = ft.typ.Comparable(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (!_r$1) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (!_r$1) { */ case 10:
						$s = -1; return false;
					/* } */ case 11:
					i = i + (1) >> 0;
				$s = 8; continue;
				case 9:
			/* } */ case 5:
		case 1:
		$s = -1; return true;
		/* */ } return; } if ($f === undefined) { $f = { $blk: rtype.ptr.prototype.Comparable }; } $f.$24r = $24r; $f._1 = _1; $f._r = _r; $f._r$1 = _r$1; $f.ft = ft; $f.i = i; $f.t = t; $f.$s = $s; $f.$r = $r; return $f;
	};
	rtype.prototype.Comparable = function() { return this.$val.Comparable(); };
	rtype.ptr.prototype.IsVariadic = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: IsVariadic of non-func type"));
		}
		tt = (t.kindType);
		return !((((tt.outCount & 32768) >>> 0) === 0));
	};
	rtype.prototype.IsVariadic = function() { return this.$val.IsVariadic(); };
	rtype.ptr.prototype.Field = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: Field of non-struct type"));
		}
		tt = (t.kindType);
		if (i < 0 || i >= tt.fields.$length) {
			$panic(new $String("reflect: Field index out of bounds"));
		}
		return (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
	};
	rtype.prototype.Field = function(i) { return this.$val.Field(i); };
	rtype.ptr.prototype.Key = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 21))) {
			$panic(new $String("reflect: Key of non-map type"));
		}
		tt = (t.kindType);
		return toType(tt.key);
	};
	rtype.prototype.Key = function() { return this.$val.Key(); };
	rtype.ptr.prototype.NumField = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: NumField of non-struct type"));
		}
		tt = (t.kindType);
		return tt.fields.$length;
	};
	rtype.prototype.NumField = function() { return this.$val.NumField(); };
	rtype.ptr.prototype.Method = function(i) {
		var $24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _i = $f._i; _i$1 = $f._i$1; _r = $f._r; _r$1 = $f._r$1; _ref = $f._ref; _ref$1 = $f._ref$1; arg = $f.arg; fl = $f.fl; fn = $f.fn; ft = $f.ft; i = $f.i; in$1 = $f.in$1; m = $f.m; methods = $f.methods; mt = $f.mt; mtyp = $f.mtyp; out = $f.out; p = $f.p; pname = $f.pname; prop = $f.prop; ret = $f.ret; t = $f.t; tt = $f.tt; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		prop = [prop];
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		t = this;
		/* */ if (t.Kind() === 20) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (t.Kind() === 20) { */ case 1:
			tt = (t.kindType);
			_r = tt.rtype.Method(i); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Method.copy(m, _r);
			$24r = m;
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		methods = t.exportedMethods();
		if (i < 0 || i >= methods.$length) {
			$panic(new $String("reflect: Method index out of range"));
		}
		p = $clone(((i < 0 || i >= methods.$length) ? ($throwRuntimeError("index out of range"), undefined) : methods.$array[methods.$offset + i]), method);
		pname = $clone(t.nameOff(p.name), name);
		m.Name = $clone(pname, name).name();
		fl = 19;
		mtyp = t.typeOff(p.mtyp);
		ft = (mtyp.kindType);
		in$1 = $makeSlice(sliceType$12, 0, (1 + ft.in$().$length >> 0));
		in$1 = $append(in$1, t);
		_ref = ft.in$();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			in$1 = $append(in$1, arg);
			_i++;
		}
		out = $makeSlice(sliceType$12, 0, ft.out().$length);
		_ref$1 = ft.out();
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			ret = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			out = $append(out, ret);
			_i$1++;
		}
		_r$1 = FuncOf(in$1, out, ft.rtype.IsVariadic()); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		mt = _r$1;
		m.Type = mt;
		prop[0] = $internalize($methodSet(t[$externalize(idJsType, $String)])[i].prop, $String);
		fn = js.MakeFunc((function(prop) { return function(this$1, arguments$1) {
			var arguments$1, rcvr, this$1;
			rcvr = (0 >= arguments$1.$length ? ($throwRuntimeError("index out of range"), undefined) : arguments$1.$array[arguments$1.$offset + 0]);
			return new $jsObjectPtr(rcvr[$externalize(prop[0], $String)].apply(rcvr, $externalize($subslice(arguments$1, 1), sliceType$8)));
		}; })(prop));
		Value.copy(m.Func, new Value.ptr($assertType(mt, ptrType$1), (fn), fl));
		m.Index = i;
		Method.copy(m, m);
		$s = -1; return m;
		/* */ } return; } if ($f === undefined) { $f = { $blk: rtype.ptr.prototype.Method }; } $f.$24r = $24r; $f._i = _i; $f._i$1 = _i$1; $f._r = _r; $f._r$1 = _r$1; $f._ref = _ref; $f._ref$1 = _ref$1; $f.arg = arg; $f.fl = fl; $f.fn = fn; $f.ft = ft; $f.i = i; $f.in$1 = in$1; $f.m = m; $f.methods = methods; $f.mt = mt; $f.mtyp = mtyp; $f.out = out; $f.p = p; $f.pname = pname; $f.prop = prop; $f.ret = ret; $f.t = t; $f.tt = tt; $f.$s = $s; $f.$r = $r; return $f;
	};
	rtype.prototype.Method = function(i) { return this.$val.Method(i); };
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	unquote = function(s) {
		var s;
		if (s.length < 2) {
			return [s, $ifaceNil];
		}
		if ((s.charCodeAt(0) === 39) || (s.charCodeAt(0) === 34)) {
			if (s.charCodeAt((s.length - 1 >> 0)) === s.charCodeAt(0)) {
				return [$substring(s, 1, (s.length - 1 >> 0)), $ifaceNil];
			}
			return ["", $pkg.ErrSyntax];
		}
		return [s, $ifaceNil];
	};
	flag.prototype.mustBe = function(expected) {
		var expected, f;
		f = this.$val;
		if (!((((((f & 31) >>> 0) >>> 0)) === expected))) {
			$panic(new ValueError.ptr(methodName(), new flag(f).kind()));
		}
	};
	$ptrType(flag).prototype.mustBe = function(expected) { return new flag(this.$get()).mustBe(expected); };
	Value.ptr.prototype.object = function() {
		var _1, newVal, v, val;
		v = this;
		if ((v.typ.Kind() === 17) || (v.typ.Kind() === 25)) {
			return v.ptr;
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			val = v.ptr.$get();
			if (!(val === $ifaceNil) && !(val.constructor === jsType(v.typ))) {
				switch (0) { default:
					_1 = v.typ.Kind();
					if ((_1 === (11)) || (_1 === (6))) {
						val = new (jsType(v.typ))(val.$high, val.$low);
					} else if ((_1 === (15)) || (_1 === (16))) {
						val = new (jsType(v.typ))(val.$real, val.$imag);
					} else if (_1 === (23)) {
						if (val === val.constructor.nil) {
							val = jsType(v.typ).nil;
							break;
						}
						newVal = new (jsType(v.typ))(val.$array);
						newVal.$offset = val.$offset;
						newVal.$length = val.$length;
						newVal.$capacity = val.$capacity;
						val = newVal;
					}
				}
			}
			return val;
		}
		return v.ptr;
	};
	Value.prototype.object = function() { return this.$val.object(); };
	Value.ptr.prototype.assignTo = function(context, dst, target) {
		var _r, _r$1, _r$2, context, dst, fl, target, v, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; context = $f.context; dst = $f.dst; fl = $f.fl; target = $f.target; v = $f.v; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue(context, $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
			_r$1 = directlyAssignable(dst, v.typ); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (_r$1) { $s = 5; continue; }
			/* */ if (implements$1(dst, v.typ)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (_r$1) { */ case 5:
				fl = (((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0;
				fl = (fl | (((dst.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(dst, v.ptr, fl);
			/* } else if (implements$1(dst, v.typ)) { */ case 6:
				if (target === 0) {
					target = unsafe_New(dst);
				}
				_r$2 = valueInterface($clone(v, Value)); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				x = _r$2;
				if (dst.NumMethod() === 0) {
					(target).$set(x);
				} else {
					ifaceE2I(dst, x, target);
				}
				$s = -1; return new Value.ptr(dst, target, 148);
			/* } */ case 7:
		case 4:
		$panic(new $String(context + ": value of type " + v.typ.String() + " is not assignable to type " + dst.String()));
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.assignTo }; } $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f.context = context; $f.dst = dst; $f.fl = fl; $f.target = target; $f.v = v; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.assignTo = function(context, dst, target) { return this.$val.assignTo(context, dst, target); };
	Value.ptr.prototype.Cap = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (17)) {
			return v.typ.Len();
		} else if ((_1 === (18)) || (_1 === (23))) {
			return $parseInt($clone(v, Value).object().$capacity) >> 0;
		}
		$panic(new ValueError.ptr("reflect.Value.Cap", k));
	};
	Value.prototype.Cap = function() { return this.$val.Cap(); };
	Value.ptr.prototype.Index = function(i) {
		var $24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; $24r$1 = $f.$24r$1; _1 = $f._1; _r = $f._r; _r$1 = $f._r$1; a = $f.a; a$1 = $f.a$1; c = $f.c; fl = $f.fl; fl$1 = $f.fl$1; fl$2 = $f.fl$2; i = $f.i; k = $f.k; s = $f.s; str = $f.str; tt = $f.tt; tt$1 = $f.tt$1; typ = $f.typ; typ$1 = $f.typ$1; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		a = [a];
		a$1 = [a$1];
		c = [c];
		i = [i];
		typ = [typ];
		typ$1 = [typ$1];
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				tt = (v.typ.kindType);
				if (i[0] < 0 || i[0] > ((tt.len >> 0))) {
					$panic(new $String("reflect: array index out of range"));
				}
				typ[0] = tt.elem;
				fl = (((((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
				a[0] = v.ptr;
				/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 7:
					$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ[0], a[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a[0][i[0]] = unwrapJsObject(typ[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl);
				/* } */ case 8:
				_r = makeValue(typ[0], wrapJsObject(typ[0], a[0][i[0]]), fl); /* */ $s = 9; case 9: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 10; case 10: return $24r;
			/* } else if (_1 === (23)) { */ case 3:
				s = $clone(v, Value).object();
				if (i[0] < 0 || i[0] >= ($parseInt(s.$length) >> 0)) {
					$panic(new $String("reflect: slice index out of range"));
				}
				tt$1 = (v.typ.kindType);
				typ$1[0] = tt$1.elem;
				fl$1 = (((384 | new flag(v.flag).ro()) >>> 0) | ((typ$1[0].Kind() >>> 0))) >>> 0;
				i[0] = i[0] + (($parseInt(s.$offset) >> 0)) >> 0;
				a$1[0] = s.$array;
				/* */ if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { */ case 11:
					$s = -1; return new Value.ptr(typ$1[0], (new (jsType(PtrTo(typ$1[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ$1[0], a$1[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a$1[0][i[0]] = unwrapJsObject(typ$1[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl$1);
				/* } */ case 12:
				_r$1 = makeValue(typ$1[0], wrapJsObject(typ$1[0], a$1[0][i[0]]), fl$1); /* */ $s = 13; case 13: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				$24r$1 = _r$1;
				$s = 14; case 14: return $24r$1;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i[0] < 0 || i[0] >= str.length) {
					$panic(new $String("reflect: string index out of range"));
				}
				fl$2 = (((new flag(v.flag).ro() | 8) >>> 0) | 128) >>> 0;
				c[0] = str.charCodeAt(i[0]);
				$s = -1; return new Value.ptr(uint8Type, ((c.$ptr || (c.$ptr = new ptrType$3(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, c)))), fl$2);
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Index", k));
			/* } */ case 6:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.Index }; } $f.$24r = $24r; $f.$24r$1 = $24r$1; $f._1 = _1; $f._r = _r; $f._r$1 = _r$1; $f.a = a; $f.a$1 = a$1; $f.c = c; $f.fl = fl; $f.fl$1 = fl$1; $f.fl$2 = fl$2; $f.i = i; $f.k = k; $f.s = s; $f.str = str; $f.tt = tt; $f.tt$1 = tt$1; $f.typ = typ; $f.typ$1 = typ$1; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.Index = function(i) { return this.$val.Index(i); };
	Value.ptr.prototype.InterfaceData = function() {
		var v;
		v = this;
		$panic(new $String("InterfaceData is not supported by GopherJS"));
	};
	Value.prototype.InterfaceData = function() { return this.$val.InterfaceData(); };
	Value.ptr.prototype.IsNil = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (22)) || (_1 === (23))) {
			return $clone(v, Value).object() === jsType(v.typ).nil;
		} else if (_1 === (18)) {
			return $clone(v, Value).object() === $chanNil;
		} else if (_1 === (19)) {
			return $clone(v, Value).object() === $throwNilPointerError;
		} else if (_1 === (21)) {
			return $clone(v, Value).object() === false;
		} else if (_1 === (20)) {
			return $clone(v, Value).object() === $ifaceNil;
		} else if (_1 === (26)) {
			return $clone(v, Value).object() === 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.IsNil", k));
		}
	};
	Value.prototype.IsNil = function() { return this.$val.IsNil(); };
	Value.ptr.prototype.Len = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (17)) || (_1 === (24))) {
			return $parseInt($clone(v, Value).object().length);
		} else if (_1 === (23)) {
			return $parseInt($clone(v, Value).object().$length) >> 0;
		} else if (_1 === (18)) {
			return $parseInt($clone(v, Value).object().$buffer.length) >> 0;
		} else if (_1 === (21)) {
			return $parseInt($keys($clone(v, Value).object()).length);
		} else {
			$panic(new ValueError.ptr("reflect.Value.Len", k));
		}
	};
	Value.prototype.Len = function() { return this.$val.Len(); };
	Value.ptr.prototype.Pointer = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (18)) || (_1 === (21)) || (_1 === (22)) || (_1 === (26))) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object();
		} else if (_1 === (19)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return 1;
		} else if (_1 === (23)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object().$array;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Pointer", k));
		}
	};
	Value.prototype.Pointer = function() { return this.$val.Pointer(); };
	Value.ptr.prototype.Set = function(x) {
		var _1, _r, _r$1, v, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _1 = $f._1; _r = $f._r; _r$1 = $f._r$1; v = $f.v; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(x.flag).mustBeExported();
		_r = $clone(x, Value).assignTo("reflect.Set", v.typ, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(x, _r);
		/* */ if (!((((v.flag & 128) >>> 0) === 0))) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (!((((v.flag & 128) >>> 0) === 0))) { */ case 2:
				_1 = v.typ.Kind();
				/* */ if (_1 === (17)) { $s = 5; continue; }
				/* */ if (_1 === (20)) { $s = 6; continue; }
				/* */ if (_1 === (25)) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (_1 === (17)) { */ case 5:
					jsType(v.typ).copy(v.ptr, x.ptr);
					$s = 9; continue;
				/* } else if (_1 === (20)) { */ case 6:
					_r$1 = valueInterface($clone(x, Value)); /* */ $s = 10; case 10: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					v.ptr.$set(_r$1);
					$s = 9; continue;
				/* } else if (_1 === (25)) { */ case 7:
					copyStruct(v.ptr, x.ptr, v.typ);
					$s = 9; continue;
				/* } else { */ case 8:
					v.ptr.$set($clone(x, Value).object());
				/* } */ case 9:
			case 4:
			$s = -1; return;
		/* } */ case 3:
		v.ptr = x.ptr;
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.Set }; } $f._1 = _1; $f._r = _r; $f._r$1 = _r$1; $f.v = v; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.Set = function(x) { return this.$val.Set(x); };
	Value.ptr.prototype.SetBytes = function(x) {
		var _r, _r$1, _v, slice, typedSlice, v, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; _v = $f._v; slice = $f.slice; typedSlice = $f.typedSlice; v = $f.v; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 8))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 8))) { */ case 1:
			$panic(new $String("reflect.Value.SetBytes of non-byte slice"));
		/* } */ case 2:
		slice = x;
		if (!(v.typ.Name() === "")) { _v = true; $s = 6; continue s; }
		_r$1 = v.typ.Elem().Name(); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_v = !(_r$1 === ""); case 6:
		/* */ if (_v) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_v) { */ case 4:
			typedSlice = new (jsType(v.typ))(slice.$array);
			typedSlice.$offset = slice.$offset;
			typedSlice.$length = slice.$length;
			typedSlice.$capacity = slice.$capacity;
			slice = typedSlice;
		/* } */ case 5:
		v.ptr.$set(slice);
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.SetBytes }; } $f._r = _r; $f._r$1 = _r$1; $f._v = _v; $f.slice = slice; $f.typedSlice = typedSlice; $f.v = v; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.SetBytes = function(x) { return this.$val.SetBytes(x); };
	Value.ptr.prototype.SetCap = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < ($parseInt(s.$length) >> 0) || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice capacity out of range in SetCap"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = s.$length;
		newSlice.$capacity = n;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetCap = function(n) { return this.$val.SetCap(n); };
	Value.ptr.prototype.SetLen = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < 0 || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice length out of range in SetLen"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = n;
		newSlice.$capacity = s.$capacity;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetLen = function(n) { return this.$val.SetLen(n); };
	Value.ptr.prototype.Slice = function(i, j) {
		var $24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; $24r$1 = $f.$24r$1; _1 = $f._1; _r = $f._r; _r$1 = $f._r$1; cap = $f.cap; i = $f.i; j = $f.j; kind = $f.kind; s = $f.s; str = $f.str; tt = $f.tt; typ = $f.typ; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
			kind = new flag(v.flag).kind();
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				if (((v.flag & 256) >>> 0) === 0) {
					$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
				}
				tt = (v.typ.kindType);
				cap = ((tt.len >> 0));
				typ = SliceOf(tt.elem);
				s = new (jsType(typ))($clone(v, Value).object());
				$s = 6; continue;
			/* } else if (_1 === (23)) { */ case 3:
				typ = v.typ;
				s = $clone(v, Value).object();
				cap = $parseInt(s.$capacity) >> 0;
				$s = 6; continue;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i < 0 || j < i || j > str.length) {
					$panic(new $String("reflect.Value.Slice: string slice index out of bounds"));
				}
				_r = ValueOf(new $String($substring(str, i, j))); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 8; case 8: return $24r;
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Slice", kind));
			/* } */ case 6:
		case 1:
		if (i < 0 || j < i || j > cap) {
			$panic(new $String("reflect.Value.Slice: slice index out of bounds"));
		}
		_r$1 = makeValue(typ, $subslice(s, i, j), new flag(v.flag).ro()); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r$1 = _r$1;
		$s = 10; case 10: return $24r$1;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.Slice }; } $f.$24r = $24r; $f.$24r$1 = $24r$1; $f._1 = _1; $f._r = _r; $f._r$1 = _r$1; $f.cap = cap; $f.i = i; $f.j = j; $f.kind = kind; $f.s = s; $f.str = str; $f.tt = tt; $f.typ = typ; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.Slice = function(i, j) { return this.$val.Slice(i, j); };
	Value.ptr.prototype.Slice3 = function(i, j, k) {
		var $24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _1 = $f._1; _r = $f._r; cap = $f.cap; i = $f.i; j = $f.j; k = $f.k; kind = $f.kind; s = $f.s; tt = $f.tt; typ = $f.typ; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
		kind = new flag(v.flag).kind();
		_1 = kind;
		if (_1 === (17)) {
			if (((v.flag & 256) >>> 0) === 0) {
				$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
			}
			tt = (v.typ.kindType);
			cap = ((tt.len >> 0));
			typ = SliceOf(tt.elem);
			s = new (jsType(typ))($clone(v, Value).object());
		} else if (_1 === (23)) {
			typ = v.typ;
			s = $clone(v, Value).object();
			cap = $parseInt(s.$capacity) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Slice3", kind));
		}
		if (i < 0 || j < i || k < j || k > cap) {
			$panic(new $String("reflect.Value.Slice3: slice index out of bounds"));
		}
		_r = makeValue(typ, $subslice(s, i, j, k), new flag(v.flag).ro()); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.Slice3 }; } $f.$24r = $24r; $f._1 = _1; $f._r = _r; $f.cap = cap; $f.i = i; $f.j = j; $f.k = k; $f.kind = kind; $f.s = s; $f.tt = tt; $f.typ = typ; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.Slice3 = function(i, j, k) { return this.$val.Slice3(i, j, k); };
	Value.ptr.prototype.Close = function() {
		var v;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		$close($clone(v, Value).object());
	};
	Value.prototype.Close = function() { return this.$val.Close(); };
	Value.ptr.prototype.Elem = function() {
		var $24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _1 = $f._1; _r = $f._r; fl = $f.fl; k = $f.k; tt = $f.tt; typ = $f.typ; v = $f.v; val = $f.val; val$1 = $f.val$1; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (20)) { $s = 2; continue; }
			/* */ if (_1 === (22)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_1 === (20)) { */ case 2:
				val = $clone(v, Value).object();
				if (val === $ifaceNil) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				typ = reflectType(val.constructor);
				_r = makeValue(typ, val.$val, new flag(v.flag).ro()); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (22)) { */ case 3:
				if ($clone(v, Value).IsNil()) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				val$1 = $clone(v, Value).object();
				tt = (v.typ.kindType);
				fl = (((((v.flag & 96) >>> 0) | 128) >>> 0) | 256) >>> 0;
				fl = (fl | (((tt.elem.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(tt.elem, (wrapJsObject(tt.elem, val$1)), fl);
			/* } else { */ case 4:
				$panic(new ValueError.ptr("reflect.Value.Elem", k));
			/* } */ case 5:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.Elem }; } $f.$24r = $24r; $f._1 = _1; $f._r = _r; $f.fl = fl; $f.k = k; $f.tt = tt; $f.typ = typ; $f.v = v; $f.val = val; $f.val$1 = val$1; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.Elem = function() { return this.$val.Elem(); };
	Value.ptr.prototype.NumField = function() {
		var tt, v;
		v = this;
		new flag(v.flag).mustBe(25);
		tt = (v.typ.kindType);
		return tt.fields.$length;
	};
	Value.prototype.NumField = function() { return this.$val.NumField(); };
	Value.ptr.prototype.MapKeys = function() {
		var _r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; a = $f.a; fl = $f.fl; i = $f.i; it = $f.it; key = $f.key; keyType = $f.keyType; m = $f.m; mlen = $f.mlen; tt = $f.tt; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		keyType = tt.key;
		fl = (new flag(v.flag).ro() | ((keyType.Kind() >>> 0))) >>> 0;
		m = $clone(v, Value).pointer();
		mlen = 0;
		if (!(m === 0)) {
			mlen = maplen(m);
		}
		it = mapiterinit(v.typ, m);
		a = $makeSlice(sliceType$9, mlen);
		i = 0;
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < a.$length)) { break; } */ if(!(i < a.$length)) { $s = 2; continue; }
			_r = mapiterkey(it); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			key = _r;
			if (key === 0) {
				/* break; */ $s = 2; continue;
			}
			Value.copy(((i < 0 || i >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + i]), copyVal(keyType, fl, key));
			mapiternext(it);
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return $subslice(a, 0, i);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.MapKeys }; } $f._r = _r; $f.a = a; $f.fl = fl; $f.i = i; $f.it = it; $f.key = key; $f.keyType = keyType; $f.m = m; $f.mlen = mlen; $f.tt = tt; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.MapKeys = function() { return this.$val.MapKeys(); };
	Value.ptr.prototype.MapIndex = function(key) {
		var _r, e, fl, k, key, tt, typ, v, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; e = $f.e; fl = $f.fl; k = $f.k; key = $f.key; tt = $f.tt; typ = $f.typ; v = $f.v; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		_r = $clone(key, Value).assignTo("reflect.Value.MapIndex", tt.key, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(key, _r);
		k = 0;
		if (!((((key.flag & 128) >>> 0) === 0))) {
			k = key.ptr;
		} else {
			k = ((key.$ptr_ptr || (key.$ptr_ptr = new ptrType$8(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, key))));
		}
		e = mapaccess(v.typ, $clone(v, Value).pointer(), k);
		if (e === 0) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		typ = tt.elem;
		fl = new flag((((v.flag | key.flag) >>> 0))).ro();
		fl = (fl | (((typ.Kind() >>> 0)))) >>> 0;
		$s = -1; return copyVal(typ, fl, e);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.MapIndex }; } $f._r = _r; $f.e = e; $f.fl = fl; $f.k = k; $f.key = key; $f.tt = tt; $f.typ = typ; $f.v = v; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.MapIndex = function(key) { return this.$val.MapIndex(key); };
	Value.ptr.prototype.Field = function(i) {
		var $24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; field = $f.field; fl = $f.fl; i = $f.i; jsTag = $f.jsTag; o = $f.o; prop = $f.prop; s = $f.s; tag = $f.tag; tt = $f.tt; typ = $f.typ; v = $f.v; x = $f.x; x$1 = $f.x$1; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		jsTag = [jsTag];
		prop = [prop];
		s = [s];
		typ = [typ];
		v = this;
		if (!((new flag(v.flag).kind() === 25))) {
			$panic(new ValueError.ptr("reflect.Value.Field", new flag(v.flag).kind()));
		}
		tt = (v.typ.kindType);
		if (((i >>> 0)) >= ((tt.fields.$length >>> 0))) {
			$panic(new $String("reflect: Field index out of range"));
		}
		prop[0] = $internalize(jsType(v.typ).fields[i].prop, $String);
		field = (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		typ[0] = field.typ;
		fl = (((v.flag & 416) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
		if (!$clone(field.name, name).isExported()) {
			if (field.embedded()) {
				fl = (fl | (64)) >>> 0;
			} else {
				fl = (fl | (32)) >>> 0;
			}
		}
		tag = $clone((x$1 = tt.fields, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])).name, name).tag();
		/* */ if (!(tag === "") && !((i === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!(tag === "") && !((i === 0))) { */ case 1:
			jsTag[0] = getJsTag(tag);
			/* */ if (!(jsTag[0] === "")) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(jsTag[0] === "")) { */ case 3:
				/* while (true) { */ case 5:
					o = [o];
					_r = $clone(v, Value).Field(0); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					Value.copy(v, _r);
					/* */ if (v.typ === jsObjectPtr) { $s = 8; continue; }
					/* */ $s = 9; continue;
					/* if (v.typ === jsObjectPtr) { */ case 8:
						o[0] = $clone(v, Value).object().object;
						$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, o, prop, s, typ) { return function() {
							return $internalize(o[0][$externalize(jsTag[0], $String)], jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ), (function(jsTag, o, prop, s, typ) { return function(x$2) {
							var x$2;
							o[0][$externalize(jsTag[0], $String)] = $externalize(x$2, jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ))), fl);
					/* } */ case 9:
					/* */ if (v.typ.Kind() === 22) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (v.typ.Kind() === 22) { */ case 10:
						_r$1 = $clone(v, Value).Elem(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
						Value.copy(v, _r$1);
					/* } */ case 11:
				$s = 5; continue;
				case 6:
			/* } */ case 4:
		/* } */ case 2:
		s[0] = v.ptr;
		/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 13; continue; }
		/* */ $s = 14; continue;
		/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 13:
			$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, prop, s, typ) { return function() {
				return wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]);
			}; })(jsTag, prop, s, typ), (function(jsTag, prop, s, typ) { return function(x$2) {
				var x$2;
				s[0][$externalize(prop[0], $String)] = unwrapJsObject(typ[0], x$2);
			}; })(jsTag, prop, s, typ))), fl);
		/* } */ case 14:
		_r$2 = makeValue(typ[0], wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]), fl); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = _r$2;
		$s = 16; case 16: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Value.ptr.prototype.Field }; } $f.$24r = $24r; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f.field = field; $f.fl = fl; $f.i = i; $f.jsTag = jsTag; $f.o = o; $f.prop = prop; $f.s = s; $f.tag = tag; $f.tt = tt; $f.typ = typ; $f.v = v; $f.x = x; $f.x$1 = x$1; $f.$s = $s; $f.$r = $r; return $f;
	};
	Value.prototype.Field = function(i) { return this.$val.Field(i); };
	structField.ptr.prototype.embedded = function() {
		var f;
		f = this;
		return !((((f.offsetEmbed & 1) >>> 0) === 0));
	};
	structField.prototype.embedded = function() { return this.$val.embedded(); };
	Kind.prototype.String = function() {
		var k;
		k = this.$val;
		if (((k >> 0)) < kindNames.$length) {
			return ((k < 0 || k >= kindNames.$length) ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + k]);
		}
		return (0 >= kindNames.$length ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + 0]);
	};
	$ptrType(Kind).prototype.String = function() { return new Kind(this.$get()).String(); };
	rtype.ptr.prototype.String = function() {
		var s, t;
		t = this;
		s = $clone(t.nameOff(t.str), name).name();
		if (!((((t.tflag & 2) >>> 0) === 0))) {
			return $substring(s, 1);
		}
		return s;
	};
	rtype.prototype.String = function() { return this.$val.String(); };
	rtype.ptr.prototype.Size = function() {
		var t;
		t = this;
		return t.size;
	};
	rtype.prototype.Size = function() { return this.$val.Size(); };
	rtype.ptr.prototype.Kind = function() {
		var t;
		t = this;
		return ((((t.kind & 31) >>> 0) >>> 0));
	};
	rtype.prototype.Kind = function() { return this.$val.Kind(); };
	rtype.ptr.prototype.pointers = function() {
		var t;
		t = this;
		return !((t.ptrdata === 0));
	};
	rtype.prototype.pointers = function() { return this.$val.pointers(); };
	rtype.ptr.prototype.common = function() {
		var t;
		t = this;
		return t;
	};
	rtype.prototype.common = function() { return this.$val.common(); };
	rtype.ptr.prototype.exportedMethods = function() {
		var t, ut;
		t = this;
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return sliceType$5.nil;
		}
		return ut.exportedMethods();
	};
	rtype.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.NumMethod = function() {
		var t, tt;
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			return tt.NumMethod();
		}
		return t.exportedMethods().$length;
	};
	rtype.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.PkgPath = function() {
		var t, ut;
		t = this;
		if (((t.tflag & 4) >>> 0) === 0) {
			return "";
		}
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return "";
		}
		return $clone(t.nameOff(ut.pkgPath), name).name();
	};
	rtype.prototype.PkgPath = function() { return this.$val.PkgPath(); };
	rtype.ptr.prototype.hasName = function() {
		var t;
		t = this;
		return !((((t.tflag & 4) >>> 0) === 0));
	};
	rtype.prototype.hasName = function() { return this.$val.hasName(); };
	rtype.ptr.prototype.Name = function() {
		var i, s, t;
		t = this;
		if (!t.hasName()) {
			return "";
		}
		s = t.String();
		i = s.length - 1 >> 0;
		while (true) {
			if (!(i >= 0 && !((s.charCodeAt(i) === 46)))) { break; }
			i = i - (1) >> 0;
		}
		return $substring(s, (i + 1 >> 0));
	};
	rtype.prototype.Name = function() { return this.$val.Name(); };
	rtype.ptr.prototype.chanDir = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 18))) {
			$panic(new $String("reflect: chanDir of non-chan type"));
		}
		tt = (t.kindType);
		return ((tt.dir >> 0));
	};
	rtype.prototype.chanDir = function() { return this.$val.chanDir(); };
	rtype.ptr.prototype.Elem = function() {
		var _1, t, tt, tt$1, tt$2, tt$3, tt$4;
		t = this;
		_1 = t.Kind();
		if (_1 === (17)) {
			tt = (t.kindType);
			return toType(tt.elem);
		} else if (_1 === (18)) {
			tt$1 = (t.kindType);
			return toType(tt$1.elem);
		} else if (_1 === (21)) {
			tt$2 = (t.kindType);
			return toType(tt$2.elem);
		} else if (_1 === (22)) {
			tt$3 = (t.kindType);
			return toType(tt$3.elem);
		} else if (_1 === (23)) {
			tt$4 = (t.kindType);
			return toType(tt$4.elem);
		}
		$panic(new $String("reflect: Elem of invalid type"));
	};
	rtype.prototype.Elem = function() { return this.$val.Elem(); };
	rtype.ptr.prototype.In = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: In of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.in$(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.In = function(i) { return this.$val.In(i); };
	rtype.ptr.prototype.Len = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 17))) {
			$panic(new $String("reflect: Len of non-array type"));
		}
		tt = (t.kindType);
		return ((tt.len >> 0));
	};
	rtype.prototype.Len = function() { return this.$val.Len(); };
	rtype.ptr.prototype.NumIn = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumIn of non-func type"));
		}
		tt = (t.kindType);
		return ((tt.inCount >> 0));
	};
	rtype.prototype.NumIn = function() { return this.$val.NumIn(); };
	rtype.ptr.prototype.NumOut = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumOut of non-func type"));
		}
		tt = (t.kindType);
		return tt.out().$length;
	};
	rtype.prototype.NumOut = function() { return this.$val.NumOut(); };
	rtype.ptr.prototype.Out = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: Out of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.out(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.Out = function(i) { return this.$val.Out(i); };
	interfaceType.ptr.prototype.NumMethod = function() {
		var t;
		t = this;
		return t.methods.$length;
	};
	interfaceType.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.Implements = function(u) {
		var _r, t, u, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; t = $f.t; u = $f.u; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.Implements"));
		}
		_r = u.Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 20))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 20))) { */ case 1:
			$panic(new $String("reflect: non-interface type passed to Type.Implements"));
		/* } */ case 2:
		$s = -1; return implements$1($assertType(u, ptrType$1), t);
		/* */ } return; } if ($f === undefined) { $f = { $blk: rtype.ptr.prototype.Implements }; } $f._r = _r; $f.t = t; $f.u = u; $f.$s = $s; $f.$r = $r; return $f;
	};
	rtype.prototype.Implements = function(u) { return this.$val.Implements(u); };
	rtype.ptr.prototype.AssignableTo = function(u) {
		var $24r, _r, t, u, uu, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; t = $f.t; u = $f.u; uu = $f.uu; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.AssignableTo"));
		}
		uu = $assertType(u, ptrType$1);
		_r = directlyAssignable(uu, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r || implements$1(uu, t);
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: rtype.ptr.prototype.AssignableTo }; } $f.$24r = $24r; $f._r = _r; $f.t = t; $f.u = u; $f.uu = uu; $f.$s = $s; $f.$r = $r; return $f;
	};
	rtype.prototype.AssignableTo = function(u) { return this.$val.AssignableTo(u); };
	implements$1 = function(T, V) {
		var T, V, i, i$1, j, j$1, t, tm, tm$1, tmName, tmName$1, tmPkgPath, tmPkgPath$1, v, v$1, vm, vm$1, vmName, vmName$1, vmPkgPath, vmPkgPath$1, vmethods, x, x$1, x$2;
		if (!((T.Kind() === 20))) {
			return false;
		}
		t = (T.kindType);
		if (t.methods.$length === 0) {
			return true;
		}
		if (V.Kind() === 20) {
			v = (V.kindType);
			i = 0;
			j = 0;
			while (true) {
				if (!(j < v.methods.$length)) { break; }
				tm = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
				tmName = $clone(t.rtype.nameOff(tm.name), name);
				vm = (x$1 = v.methods, ((j < 0 || j >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + j]));
				vmName = $clone(V.nameOff(vm.name), name);
				if ($clone(vmName, name).name() === $clone(tmName, name).name() && V.typeOff(vm.typ) === t.rtype.typeOff(tm.typ)) {
					if (!$clone(tmName, name).isExported()) {
						tmPkgPath = $clone(tmName, name).pkgPath();
						if (tmPkgPath === "") {
							tmPkgPath = $clone(t.pkgPath, name).name();
						}
						vmPkgPath = $clone(vmName, name).pkgPath();
						if (vmPkgPath === "") {
							vmPkgPath = $clone(v.pkgPath, name).name();
						}
						if (!(tmPkgPath === vmPkgPath)) {
							j = j + (1) >> 0;
							continue;
						}
					}
					i = i + (1) >> 0;
					if (i >= t.methods.$length) {
						return true;
					}
				}
				j = j + (1) >> 0;
			}
			return false;
		}
		v$1 = V.uncommon();
		if (v$1 === ptrType$4.nil) {
			return false;
		}
		i$1 = 0;
		vmethods = v$1.methods();
		j$1 = 0;
		while (true) {
			if (!(j$1 < ((v$1.mcount >> 0)))) { break; }
			tm$1 = (x$2 = t.methods, ((i$1 < 0 || i$1 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i$1]));
			tmName$1 = $clone(t.rtype.nameOff(tm$1.name), name);
			vm$1 = $clone(((j$1 < 0 || j$1 >= vmethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : vmethods.$array[vmethods.$offset + j$1]), method);
			vmName$1 = $clone(V.nameOff(vm$1.name), name);
			if ($clone(vmName$1, name).name() === $clone(tmName$1, name).name() && V.typeOff(vm$1.mtyp) === t.rtype.typeOff(tm$1.typ)) {
				if (!$clone(tmName$1, name).isExported()) {
					tmPkgPath$1 = $clone(tmName$1, name).pkgPath();
					if (tmPkgPath$1 === "") {
						tmPkgPath$1 = $clone(t.pkgPath, name).name();
					}
					vmPkgPath$1 = $clone(vmName$1, name).pkgPath();
					if (vmPkgPath$1 === "") {
						vmPkgPath$1 = $clone(V.nameOff(v$1.pkgPath), name).name();
					}
					if (!(tmPkgPath$1 === vmPkgPath$1)) {
						j$1 = j$1 + (1) >> 0;
						continue;
					}
				}
				i$1 = i$1 + (1) >> 0;
				if (i$1 >= t.methods.$length) {
					return true;
				}
			}
			j$1 = j$1 + (1) >> 0;
		}
		return false;
	};
	directlyAssignable = function(T, V) {
		var $24r, T, V, _r, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; T = $f.T; V = $f.V; _r = $f._r; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		if (T.hasName() && V.hasName() || !((T.Kind() === V.Kind()))) {
			$s = -1; return false;
		}
		_r = haveIdenticalUnderlyingType(T, V, true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: directlyAssignable }; } $f.$24r = $24r; $f.T = T; $f.V = V; $f._r = _r; $f.$s = $s; $f.$r = $r; return $f;
	};
	haveIdenticalType = function(T, V, cmpTags) {
		var $24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; T = $f.T; V = $f.V; _arg = $f._arg; _arg$1 = $f._arg$1; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; _r$3 = $f._r$3; _r$4 = $f._r$4; _r$5 = $f._r$5; _r$6 = $f._r$6; _v = $f._v; cmpTags = $f.cmpTags; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		if (cmpTags) {
			$s = -1; return $interfaceIsEqual(T, V);
		}
		_r = T.Name(); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = V.Name(); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (!(_r === _r$1)) { _v = true; $s = 3; continue s; }
		_r$2 = T.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = V.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = !((_r$2 === _r$3)); case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$s = -1; return false;
		/* } */ case 2:
		_r$4 = T.common(); /* */ $s = 8; case 8: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		_arg = _r$4;
		_r$5 = V.common(); /* */ $s = 9; case 9: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		_arg$1 = _r$5;
		_r$6 = haveIdenticalUnderlyingType(_arg, _arg$1, false); /* */ $s = 10; case 10: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		$24r = _r$6;
		$s = 11; case 11: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: haveIdenticalType }; } $f.$24r = $24r; $f.T = T; $f.V = V; $f._arg = _arg; $f._arg$1 = _arg$1; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f._r$3 = _r$3; $f._r$4 = _r$4; $f._r$5 = _r$5; $f._r$6 = _r$6; $f._v = _v; $f.cmpTags = cmpTags; $f.$s = $s; $f.$r = $r; return $f;
	};
	haveIdenticalUnderlyingType = function(T, V, cmpTags) {
		var $24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; $24r$1 = $f.$24r$1; $24r$2 = $f.$24r$2; $24r$3 = $f.$24r$3; T = $f.T; V = $f.V; _1 = $f._1; _i = $f._i; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; _r$3 = $f._r$3; _r$4 = $f._r$4; _r$5 = $f._r$5; _r$6 = $f._r$6; _r$7 = $f._r$7; _r$8 = $f._r$8; _ref = $f._ref; _v = $f._v; _v$1 = $f._v$1; _v$2 = $f._v$2; _v$3 = $f._v$3; cmpTags = $f.cmpTags; i = $f.i; i$1 = $f.i$1; i$2 = $f.i$2; kind = $f.kind; t = $f.t; t$1 = $f.t$1; t$2 = $f.t$2; tf = $f.tf; v = $f.v; v$1 = $f.v$1; v$2 = $f.v$2; vf = $f.vf; x = $f.x; x$1 = $f.x$1; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		kind = T.Kind();
		if (!((kind === V.Kind()))) {
			$s = -1; return false;
		}
		if (1 <= kind && kind <= 16 || (kind === 24) || (kind === 26)) {
			$s = -1; return true;
		}
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (18)) { $s = 3; continue; }
			/* */ if (_1 === (19)) { $s = 4; continue; }
			/* */ if (_1 === (20)) { $s = 5; continue; }
			/* */ if (_1 === (21)) { $s = 6; continue; }
			/* */ if ((_1 === (22)) || (_1 === (23))) { $s = 7; continue; }
			/* */ if (_1 === (25)) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if (_1 === (17)) { */ case 2:
				if (!(T.Len() === V.Len())) { _v = false; $s = 10; continue s; }
				_r = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 10:
				$24r = _v;
				$s = 12; case 12: return $24r;
			/* } else if (_1 === (18)) { */ case 3:
				if (!(V.chanDir() === 3)) { _v$1 = false; $s = 15; continue s; }
				_r$1 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 16; case 16: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = _r$1; case 15:
				/* */ if (_v$1) { $s = 13; continue; }
				/* */ $s = 14; continue;
				/* if (_v$1) { */ case 13:
					$s = -1; return true;
				/* } */ case 14:
				if (!(V.chanDir() === T.chanDir())) { _v$2 = false; $s = 17; continue s; }
				_r$2 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 18; case 18: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$2 = _r$2; case 17:
				$24r$1 = _v$2;
				$s = 19; case 19: return $24r$1;
			/* } else if (_1 === (19)) { */ case 4:
				t = (T.kindType);
				v = (V.kindType);
				if (!((t.outCount === v.outCount)) || !((t.inCount === v.inCount))) {
					$s = -1; return false;
				}
				i = 0;
				/* while (true) { */ case 20:
					/* if (!(i < t.rtype.NumIn())) { break; } */ if(!(i < t.rtype.NumIn())) { $s = 21; continue; }
					_r$3 = haveIdenticalType(t.rtype.In(i), v.rtype.In(i), cmpTags); /* */ $s = 24; case 24: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					/* */ if (!_r$3) { $s = 22; continue; }
					/* */ $s = 23; continue;
					/* if (!_r$3) { */ case 22:
						$s = -1; return false;
					/* } */ case 23:
					i = i + (1) >> 0;
				$s = 20; continue;
				case 21:
				i$1 = 0;
				/* while (true) { */ case 25:
					/* if (!(i$1 < t.rtype.NumOut())) { break; } */ if(!(i$1 < t.rtype.NumOut())) { $s = 26; continue; }
					_r$4 = haveIdenticalType(t.rtype.Out(i$1), v.rtype.Out(i$1), cmpTags); /* */ $s = 29; case 29: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					/* */ if (!_r$4) { $s = 27; continue; }
					/* */ $s = 28; continue;
					/* if (!_r$4) { */ case 27:
						$s = -1; return false;
					/* } */ case 28:
					i$1 = i$1 + (1) >> 0;
				$s = 25; continue;
				case 26:
				$s = -1; return true;
			/* } else if (_1 === (20)) { */ case 5:
				t$1 = (T.kindType);
				v$1 = (V.kindType);
				if ((t$1.methods.$length === 0) && (v$1.methods.$length === 0)) {
					$s = -1; return true;
				}
				$s = -1; return false;
			/* } else if (_1 === (21)) { */ case 6:
				_r$5 = haveIdenticalType(T.Key(), V.Key(), cmpTags); /* */ $s = 31; case 31: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				if (!(_r$5)) { _v$3 = false; $s = 30; continue s; }
				_r$6 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 32; case 32: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				_v$3 = _r$6; case 30:
				$24r$2 = _v$3;
				$s = 33; case 33: return $24r$2;
			/* } else if ((_1 === (22)) || (_1 === (23))) { */ case 7:
				_r$7 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 34; case 34: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
				$24r$3 = _r$7;
				$s = 35; case 35: return $24r$3;
			/* } else if (_1 === (25)) { */ case 8:
				t$2 = (T.kindType);
				v$2 = (V.kindType);
				if (!((t$2.fields.$length === v$2.fields.$length))) {
					$s = -1; return false;
				}
				if (!($clone(t$2.pkgPath, name).name() === $clone(v$2.pkgPath, name).name())) {
					$s = -1; return false;
				}
				_ref = t$2.fields;
				_i = 0;
				/* while (true) { */ case 36:
					/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 37; continue; }
					i$2 = _i;
					tf = (x = t$2.fields, ((i$2 < 0 || i$2 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i$2]));
					vf = (x$1 = v$2.fields, ((i$2 < 0 || i$2 >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i$2]));
					if (!($clone(tf.name, name).name() === $clone(vf.name, name).name())) {
						$s = -1; return false;
					}
					_r$8 = haveIdenticalType(tf.typ, vf.typ, cmpTags); /* */ $s = 40; case 40: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
					/* */ if (!_r$8) { $s = 38; continue; }
					/* */ $s = 39; continue;
					/* if (!_r$8) { */ case 38:
						$s = -1; return false;
					/* } */ case 39:
					if (cmpTags && !($clone(tf.name, name).tag() === $clone(vf.name, name).tag())) {
						$s = -1; return false;
					}
					if (!((tf.offsetEmbed === vf.offsetEmbed))) {
						$s = -1; return false;
					}
					_i++;
				$s = 36; continue;
				case 37:
				$s = -1; return true;
			/* } */ case 9:
		case 1:
		$s = -1; return false;
		/* */ } return; } if ($f === undefined) { $f = { $blk: haveIdenticalUnderlyingType }; } $f.$24r = $24r; $f.$24r$1 = $24r$1; $f.$24r$2 = $24r$2; $f.$24r$3 = $24r$3; $f.T = T; $f.V = V; $f._1 = _1; $f._i = _i; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f._r$3 = _r$3; $f._r$4 = _r$4; $f._r$5 = _r$5; $f._r$6 = _r$6; $f._r$7 = _r$7; $f._r$8 = _r$8; $f._ref = _ref; $f._v = _v; $f._v$1 = _v$1; $f._v$2 = _v$2; $f._v$3 = _v$3; $f.cmpTags = cmpTags; $f.i = i; $f.i$1 = i$1; $f.i$2 = i$2; $f.kind = kind; $f.t = t; $f.t$1 = t$1; $f.t$2 = t$2; $f.tf = tf; $f.v = v; $f.v$1 = v$1; $f.v$2 = v$2; $f.vf = vf; $f.x = x; $f.x$1 = x$1; $f.$s = $s; $f.$r = $r; return $f;
	};
	toType = function(t) {
		var t;
		if (t === ptrType$1.nil) {
			return $ifaceNil;
		}
		return t;
	};
	ifaceIndir = function(t) {
		var t;
		return ((t.kind & 32) >>> 0) === 0;
	};
	flag.prototype.kind = function() {
		var f;
		f = this.$val;
		return ((((f & 31) >>> 0) >>> 0));
	};
	$ptrType(flag).prototype.kind = function() { return new flag(this.$get()).kind(); };
	flag.prototype.ro = function() {
		var f;
		f = this.$val;
		if (!((((f & 96) >>> 0) === 0))) {
			return 32;
		}
		return 0;
	};
	$ptrType(flag).prototype.ro = function() { return new flag(this.$get()).ro(); };
	Value.ptr.prototype.pointer = function() {
		var v;
		v = this;
		if (!((v.typ.size === 4)) || !v.typ.pointers()) {
			$panic(new $String("can't call pointer on a non-pointer Value"));
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			return (v.ptr).$get();
		}
		return v.ptr;
	};
	Value.prototype.pointer = function() { return this.$val.pointer(); };
	ValueError.ptr.prototype.Error = function() {
		var e;
		e = this;
		if (e.Kind === 0) {
			return "reflect: call of " + e.Method + " on zero Value";
		}
		return "reflect: call of " + e.Method + " on " + new Kind(e.Kind).String() + " Value";
	};
	ValueError.prototype.Error = function() { return this.$val.Error(); };
	flag.prototype.mustBeExported = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
	};
	$ptrType(flag).prototype.mustBeExported = function() { return new flag(this.$get()).mustBeExported(); };
	flag.prototype.mustBeAssignable = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
		if (((f & 256) >>> 0) === 0) {
			$panic(new $String("reflect: " + methodName() + " using unaddressable value"));
		}
	};
	$ptrType(flag).prototype.mustBeAssignable = function() { return new flag(this.$get()).mustBeAssignable(); };
	Value.ptr.prototype.CanSet = function() {
		var v;
		v = this;
		return ((v.flag & 352) >>> 0) === 256;
	};
	Value.prototype.CanSet = function() { return this.$val.CanSet(); };
	Value.ptr.prototype.IsValid = function() {
		var v;
		v = this;
		return !((v.flag === 0));
	};
	Value.prototype.IsValid = function() { return this.$val.IsValid(); };
	Value.ptr.prototype.Kind = function() {
		var v;
		v = this;
		return new flag(v.flag).kind();
	};
	Value.prototype.Kind = function() { return this.$val.Kind(); };
	Value.ptr.prototype.Type = function() {
		var f, v;
		v = this;
		f = v.flag;
		if (f === 0) {
			$panic(new ValueError.ptr("reflectlite.Value.Type", 0));
		}
		return v.typ;
	};
	Value.prototype.Type = function() { return this.$val.Type(); };
	ptrType$4.methods = [{prop: "methods", name: "methods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}];
	ptrType$7.methods = [{prop: "in$", name: "in", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}, {prop: "out", name: "out", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}];
	name.methods = [{prop: "name", name: "name", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "tag", name: "tag", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "pkgPath", name: "pkgPath", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "isExported", name: "isExported", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "data", name: "data", pkg: "internal/reflectlite", typ: $funcType([$Int, $String], [ptrType$3], false)}, {prop: "hasTag", name: "hasTag", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "readVarint", name: "readVarint", pkg: "internal/reflectlite", typ: $funcType([$Int], [$Int, $Int], false)}];
	ptrType$6.methods = [{prop: "skipUntilValidKey", name: "skipUntilValidKey", pkg: "internal/reflectlite", typ: $funcType([], [], false)}];
	ptrType$10.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	Kind.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$1.methods = [{prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}, {prop: "nameOff", name: "nameOff", pkg: "internal/reflectlite", typ: $funcType([nameOff], [name], false)}, {prop: "typeOff", name: "typeOff", pkg: "internal/reflectlite", typ: $funcType([typeOff], [ptrType$1], false)}, {prop: "ptrTo", name: "ptrTo", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsVariadic", name: "IsVariadic", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "kindType", name: "kindType", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [structField], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "pointers", name: "pointers", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "hasName", name: "hasName", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "chanDir", name: "chanDir", pkg: "internal/reflectlite", typ: $funcType([], [chanDir], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "In", name: "In", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumIn", name: "NumIn", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumOut", name: "NumOut", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Out", name: "Out", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}];
	ptrType$11.methods = [{prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}];
	ptrType$12.methods = [{prop: "offset", name: "offset", pkg: "internal/reflectlite", typ: $funcType([], [$Uintptr], false)}, {prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	Value.methods = [{prop: "object", name: "object", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$2], false)}, {prop: "assignTo", name: "assignTo", pkg: "internal/reflectlite", typ: $funcType([$String, ptrType$1, $UnsafePointer], [Value], false)}, {prop: "call", name: "call", pkg: "internal/reflectlite", typ: $funcType([$String, sliceType$9], [sliceType$9], false)}, {prop: "Cap", name: "Cap", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "InterfaceData", name: "InterfaceData", pkg: "", typ: $funcType([], [arrayType$2], false)}, {prop: "IsNil", name: "IsNil", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Pointer", name: "Pointer", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([Value], [], false)}, {prop: "SetBytes", name: "SetBytes", pkg: "", typ: $funcType([sliceType$13], [], false)}, {prop: "SetCap", name: "SetCap", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "SetLen", name: "SetLen", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "Slice", name: "Slice", pkg: "", typ: $funcType([$Int, $Int], [Value], false)}, {prop: "Slice3", name: "Slice3", pkg: "", typ: $funcType([$Int, $Int, $Int], [Value], false)}, {prop: "Close", name: "Close", pkg: "", typ: $funcType([], [], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Value], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MapKeys", name: "MapKeys", pkg: "", typ: $funcType([], [sliceType$9], false)}, {prop: "MapIndex", name: "MapIndex", pkg: "", typ: $funcType([Value], [Value], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "pointer", name: "pointer", pkg: "internal/reflectlite", typ: $funcType([], [$UnsafePointer], false)}, {prop: "CanSet", name: "CanSet", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsValid", name: "IsValid", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "numMethod", name: "numMethod", pkg: "internal/reflectlite", typ: $funcType([], [$Int], false)}, {prop: "Type", name: "Type", pkg: "", typ: $funcType([], [Type], false)}];
	flag.methods = [{prop: "mustBe", name: "mustBe", pkg: "internal/reflectlite", typ: $funcType([Kind], [], false)}, {prop: "kind", name: "kind", pkg: "internal/reflectlite", typ: $funcType([], [Kind], false)}, {prop: "ro", name: "ro", pkg: "internal/reflectlite", typ: $funcType([], [flag], false)}, {prop: "mustBeExported", name: "mustBeExported", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBeAssignable", name: "mustBeAssignable", pkg: "internal/reflectlite", typ: $funcType([], [], false)}];
	ptrType$13.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	uncommonType.init("internal/reflectlite", [{prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mcount", name: "mcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "xcount", name: "xcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "moff", name: "moff", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "_methods", name: "_methods", embedded: false, exported: false, typ: sliceType$5, tag: ""}]);
	funcType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: "reflect:\"func\""}, {prop: "inCount", name: "inCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "outCount", name: "outCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "_in", name: "_in", embedded: false, exported: false, typ: sliceType$2, tag: ""}, {prop: "_out", name: "_out", embedded: false, exported: false, typ: sliceType$2, tag: ""}]);
	name.init("internal/reflectlite", [{prop: "bytes", name: "bytes", embedded: false, exported: false, typ: ptrType$3, tag: ""}]);
	nameData.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "tag", name: "tag", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "exported", name: "exported", embedded: false, exported: false, typ: $Bool, tag: ""}]);
	mapIter.init("internal/reflectlite", [{prop: "t", name: "t", embedded: false, exported: false, typ: Type, tag: ""}, {prop: "m", name: "m", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "keys", name: "keys", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "i", name: "i", embedded: false, exported: false, typ: $Int, tag: ""}, {prop: "last", name: "last", embedded: false, exported: false, typ: ptrType$2, tag: ""}]);
	TypeEx.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	errorString.init("internal/reflectlite", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	Method.init("", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "PkgPath", name: "PkgPath", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}, {prop: "Func", name: "Func", embedded: false, exported: true, typ: Value, tag: ""}, {prop: "Index", name: "Index", embedded: false, exported: true, typ: $Int, tag: ""}]);
	Type.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	rtype.init("internal/reflectlite", [{prop: "size", name: "size", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "ptrdata", name: "ptrdata", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "hash", name: "hash", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "tflag", name: "tflag", embedded: false, exported: false, typ: tflag, tag: ""}, {prop: "align", name: "align", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "fieldAlign", name: "fieldAlign", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "kind", name: "kind", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "equal", name: "equal", embedded: false, exported: false, typ: funcType$2, tag: ""}, {prop: "gcdata", name: "gcdata", embedded: false, exported: false, typ: ptrType$3, tag: ""}, {prop: "str", name: "str", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "ptrToThis", name: "ptrToThis", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	method.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mtyp", name: "mtyp", embedded: false, exported: false, typ: typeOff, tag: ""}, {prop: "ifn", name: "ifn", embedded: false, exported: false, typ: textOff, tag: ""}, {prop: "tfn", name: "tfn", embedded: false, exported: false, typ: textOff, tag: ""}]);
	arrayType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "slice", name: "slice", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "len", name: "len", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	chanType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "dir", name: "dir", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	imethod.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	interfaceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "methods", name: "methods", embedded: false, exported: false, typ: sliceType$6, tag: ""}]);
	mapType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "bucket", name: "bucket", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "hasher", name: "hasher", embedded: false, exported: false, typ: funcType$3, tag: ""}, {prop: "keysize", name: "keysize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "valuesize", name: "valuesize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "bucketsize", name: "bucketsize", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "flags", name: "flags", embedded: false, exported: false, typ: $Uint32, tag: ""}]);
	ptrType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	sliceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	structField.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: name, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "offsetEmbed", name: "offsetEmbed", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	structType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "fields", name: "fields", embedded: false, exported: false, typ: sliceType$7, tag: ""}]);
	Value.init("internal/reflectlite", [{prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "ptr", name: "ptr", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "flag", name: "flag", embedded: true, exported: false, typ: flag, tag: ""}]);
	ValueError.init("", [{prop: "Method", name: "Method", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Kind", name: "Kind", embedded: false, exported: true, typ: Kind, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = unsafeheader.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = runtime.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		uint8Type = ptrType$1.nil;
		nameOffList = sliceType$1.nil;
		typeOffList = sliceType$2.nil;
		initialized = false;
		idJsType = "_jsType";
		idReflectType = "_reflectType";
		idKindType = "kindType";
		idRtype = "_rtype";
		uncommonTypeMap = {};
		nameMap = {};
		selectHelper = $assertType($internalize($select, $emptyInterface), funcType$1);
		$pkg.ErrSyntax = new errorString.ptr("invalid syntax");
		callHelper = $assertType($internalize($call, $emptyInterface), funcType$1);
		jsObjectPtr = reflectType($jsObjectPtr);
		kindNames = new sliceType$4(["invalid", "bool", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "array", "chan", "func", "interface", "map", "ptr", "slice", "string", "struct", "unsafe.Pointer"]);
		$r = init(); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["sort"] = (function() {
	var $pkg = {}, $init, reflectlite, lessSwap, StringSlice, sliceType$2, funcType, funcType$1, reflectValueOf, reflectSwapper, Search, SearchStrings, SliceStable, insertionSort, siftDown, heapSort, medianOfThree, doPivot, quickSort, Sort, maxDepth, Strings, insertionSort_func, swapRange_func, stable_func, symMerge_func, rotate_func;
	reflectlite = $packages["internal/reflectlite"];
	lessSwap = $pkg.lessSwap = $newType(0, $kindStruct, "sort.lessSwap", true, "sort", false, function(Less_, Swap_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Less = $throwNilPointerError;
			this.Swap = $throwNilPointerError;
			return;
		}
		this.Less = Less_;
		this.Swap = Swap_;
	});
	StringSlice = $pkg.StringSlice = $newType(12, $kindSlice, "sort.StringSlice", true, "sort", true, null);
	sliceType$2 = $sliceType($String);
	funcType = $funcType([$Int, $Int], [$Bool], false);
	funcType$1 = $funcType([$Int, $Int], [], false);
	Search = function(n, f) {
		var _r, _tmp, _tmp$1, f, h, i, j, n, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _tmp = $f._tmp; _tmp$1 = $f._tmp$1; f = $f.f; h = $f.h; i = $f.i; j = $f.j; n = $f.n; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		_tmp = 0;
		_tmp$1 = n;
		i = _tmp;
		j = _tmp$1;
		/* while (true) { */ case 1:
			/* if (!(i < j)) { break; } */ if(!(i < j)) { $s = 2; continue; }
			h = ((((((i + j >> 0) >>> 0)) >>> 1 >>> 0) >> 0));
			_r = f(h); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (!_r) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!_r) { */ case 3:
				i = h + 1 >> 0;
				$s = 5; continue;
			/* } else { */ case 4:
				j = h;
			/* } */ case 5:
		$s = 1; continue;
		case 2:
		$s = -1; return i;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Search }; } $f._r = _r; $f._tmp = _tmp; $f._tmp$1 = _tmp$1; $f.f = f; $f.h = h; $f.i = i; $f.j = j; $f.n = n; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.Search = Search;
	SearchStrings = function(a, x) {
		var $24r, _r, a, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; a = $f.a; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		a = [a];
		x = [x];
		_r = Search(a[0].$length, (function(a, x) { return function(i) {
			var i;
			return ((i < 0 || i >= a[0].$length) ? ($throwRuntimeError("index out of range"), undefined) : a[0].$array[a[0].$offset + i]) >= x[0];
		}; })(a, x)); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: SearchStrings }; } $f.$24r = $24r; $f._r = _r; $f.a = a; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.SearchStrings = SearchStrings;
	StringSlice.prototype.Search = function(x) {
		var $24r, _r, p, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; p = $f.p; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		p = this;
		_r = SearchStrings($convertSliceType(p, sliceType$2), x); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: StringSlice.prototype.Search }; } $f.$24r = $24r; $f._r = _r; $f.p = p; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	$ptrType(StringSlice).prototype.Search = function(x) { return this.$get().Search(x); };
	SliceStable = function(x, less) {
		var _r, _r$1, less, rv, swap, x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; less = $f.less; rv = $f.rv; swap = $f.swap; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		_r = reflectValueOf(x); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rv = $clone(_r, reflectlite.Value);
		_r$1 = reflectSwapper(x); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		swap = _r$1;
		$r = stable_func(new lessSwap.ptr(less, swap), $clone(rv, reflectlite.Value).Len()); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: SliceStable }; } $f._r = _r; $f._r$1 = _r$1; $f.less = less; $f.rv = rv; $f.swap = swap; $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.SliceStable = SliceStable;
	insertionSort = function(data, a, b) {
		var _r, _v, a, b, data, i, j, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _v = $f._v; a = $f.a; b = $f.b; data = $f.data; i = $f.i; j = $f.j; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		i = a + 1 >> 0;
		/* while (true) { */ case 1:
			/* if (!(i < b)) { break; } */ if(!(i < b)) { $s = 2; continue; }
			j = i;
			/* while (true) { */ case 3:
				if (!(j > a)) { _v = false; $s = 5; continue s; }
				_r = data.Less(j, j - 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 5:
				/* if (!(_v)) { break; } */ if(!(_v)) { $s = 4; continue; }
				$r = data.Swap(j, j - 1 >> 0); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				j = j - (1) >> 0;
			$s = 3; continue;
			case 4:
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: insertionSort }; } $f._r = _r; $f._v = _v; $f.a = a; $f.b = b; $f.data = data; $f.i = i; $f.j = j; $f.$s = $s; $f.$r = $r; return $f;
	};
	siftDown = function(data, lo, hi, first) {
		var _r, _r$1, _v, child, data, first, hi, lo, root, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; _v = $f._v; child = $f.child; data = $f.data; first = $f.first; hi = $f.hi; lo = $f.lo; root = $f.root; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		root = lo;
		/* while (true) { */ case 1:
			child = ($imul(2, root)) + 1 >> 0;
			if (child >= hi) {
				/* break; */ $s = 2; continue;
			}
			if (!((child + 1 >> 0) < hi)) { _v = false; $s = 5; continue s; }
			_r = data.Less(first + child >> 0, (first + child >> 0) + 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_v = _r; case 5:
			/* */ if (_v) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_v) { */ case 3:
				child = child + (1) >> 0;
			/* } */ case 4:
			_r$1 = data.Less(first + root >> 0, first + child >> 0); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (!_r$1) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if (!_r$1) { */ case 7:
				$s = -1; return;
			/* } */ case 8:
			$r = data.Swap(first + root >> 0, first + child >> 0); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			root = child;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: siftDown }; } $f._r = _r; $f._r$1 = _r$1; $f._v = _v; $f.child = child; $f.data = data; $f.first = first; $f.hi = hi; $f.lo = lo; $f.root = root; $f.$s = $s; $f.$r = $r; return $f;
	};
	heapSort = function(data, a, b) {
		var _q, a, b, data, first, hi, i, i$1, lo, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _q = $f._q; a = $f.a; b = $f.b; data = $f.data; first = $f.first; hi = $f.hi; i = $f.i; i$1 = $f.i$1; lo = $f.lo; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		first = a;
		lo = 0;
		hi = b - a >> 0;
		i = (_q = ((hi - 1 >> 0)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"));
		/* while (true) { */ case 1:
			/* if (!(i >= 0)) { break; } */ if(!(i >= 0)) { $s = 2; continue; }
			$r = siftDown(data, i, hi, first); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i - (1) >> 0;
		$s = 1; continue;
		case 2:
		i$1 = hi - 1 >> 0;
		/* while (true) { */ case 4:
			/* if (!(i$1 >= 0)) { break; } */ if(!(i$1 >= 0)) { $s = 5; continue; }
			$r = data.Swap(first, first + i$1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$r = siftDown(data, lo, i$1, first); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i$1 = i$1 - (1) >> 0;
		$s = 4; continue;
		case 5:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: heapSort }; } $f._q = _q; $f.a = a; $f.b = b; $f.data = data; $f.first = first; $f.hi = hi; $f.i = i; $f.i$1 = i$1; $f.lo = lo; $f.$s = $s; $f.$r = $r; return $f;
	};
	medianOfThree = function(data, m1, m0, m2) {
		var _r, _r$1, _r$2, data, m0, m1, m2, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; data = $f.data; m0 = $f.m0; m1 = $f.m1; m2 = $f.m2; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		_r = data.Less(m1, m0); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (_r) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_r) { */ case 1:
			$r = data.Swap(m1, m0); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		_r$1 = data.Less(m2, m1); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		/* */ if (_r$1) { $s = 5; continue; }
		/* */ $s = 6; continue;
		/* if (_r$1) { */ case 5:
			$r = data.Swap(m2, m1); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_r$2 = data.Less(m1, m0); /* */ $s = 11; case 11: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			/* */ if (_r$2) { $s = 9; continue; }
			/* */ $s = 10; continue;
			/* if (_r$2) { */ case 9:
				$r = data.Swap(m1, m0); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 10:
		/* } */ case 6:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: medianOfThree }; } $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f.data = data; $f.m0 = m0; $f.m1 = m1; $f.m2 = m2; $f.$s = $s; $f.$r = $r; return $f;
	};
	doPivot = function(data, lo, hi) {
		var _q, _q$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _tmp, _tmp$1, _tmp$2, _tmp$3, _v, _v$1, _v$2, _v$3, _v$4, a, b, c, data, dups, hi, lo, m, midhi, midlo, pivot, protect, s, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _q = $f._q; _q$1 = $f._q$1; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; _r$3 = $f._r$3; _r$4 = $f._r$4; _r$5 = $f._r$5; _r$6 = $f._r$6; _r$7 = $f._r$7; _tmp = $f._tmp; _tmp$1 = $f._tmp$1; _tmp$2 = $f._tmp$2; _tmp$3 = $f._tmp$3; _v = $f._v; _v$1 = $f._v$1; _v$2 = $f._v$2; _v$3 = $f._v$3; _v$4 = $f._v$4; a = $f.a; b = $f.b; c = $f.c; data = $f.data; dups = $f.dups; hi = $f.hi; lo = $f.lo; m = $f.m; midhi = $f.midhi; midlo = $f.midlo; pivot = $f.pivot; protect = $f.protect; s = $f.s; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		midlo = 0;
		midhi = 0;
		m = ((((((lo + hi >> 0) >>> 0)) >>> 1 >>> 0) >> 0));
		/* */ if ((hi - lo >> 0) > 40) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if ((hi - lo >> 0) > 40) { */ case 1:
			s = (_q = ((hi - lo >> 0)) / 8, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"));
			$r = medianOfThree(data, lo, lo + s >> 0, lo + ($imul(2, s)) >> 0); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$r = medianOfThree(data, m, m - s >> 0, m + s >> 0); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$r = medianOfThree(data, hi - 1 >> 0, (hi - 1 >> 0) - s >> 0, (hi - 1 >> 0) - ($imul(2, s)) >> 0); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 2:
		$r = medianOfThree(data, lo, m, hi - 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		pivot = lo;
		_tmp = lo + 1 >> 0;
		_tmp$1 = hi - 1 >> 0;
		a = _tmp;
		c = _tmp$1;
		/* while (true) { */ case 7:
			if (!(a < c)) { _v = false; $s = 9; continue s; }
			_r = data.Less(a, pivot); /* */ $s = 10; case 10: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_v = _r; case 9:
			/* if (!(_v)) { break; } */ if(!(_v)) { $s = 8; continue; }
			a = a + (1) >> 0;
		$s = 7; continue;
		case 8:
		b = a;
		/* while (true) { */ case 11:
			/* while (true) { */ case 13:
				if (!(b < c)) { _v$1 = false; $s = 15; continue s; }
				_r$1 = data.Less(pivot, b); /* */ $s = 16; case 16: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = !_r$1; case 15:
				/* if (!(_v$1)) { break; } */ if(!(_v$1)) { $s = 14; continue; }
				b = b + (1) >> 0;
			$s = 13; continue;
			case 14:
			/* while (true) { */ case 17:
				if (!(b < c)) { _v$2 = false; $s = 19; continue s; }
				_r$2 = data.Less(pivot, c - 1 >> 0); /* */ $s = 20; case 20: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$2 = _r$2; case 19:
				/* if (!(_v$2)) { break; } */ if(!(_v$2)) { $s = 18; continue; }
				c = c - (1) >> 0;
			$s = 17; continue;
			case 18:
			if (b >= c) {
				/* break; */ $s = 12; continue;
			}
			$r = data.Swap(b, c - 1 >> 0); /* */ $s = 21; case 21: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			b = b + (1) >> 0;
			c = c - (1) >> 0;
		$s = 11; continue;
		case 12:
		protect = (hi - c >> 0) < 5;
		/* */ if (!protect && (hi - c >> 0) < (_q$1 = ((hi - lo >> 0)) / 4, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero"))) { $s = 22; continue; }
		/* */ $s = 23; continue;
		/* if (!protect && (hi - c >> 0) < (_q$1 = ((hi - lo >> 0)) / 4, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero"))) { */ case 22:
			dups = 0;
			_r$3 = data.Less(pivot, hi - 1 >> 0); /* */ $s = 26; case 26: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			/* */ if (!_r$3) { $s = 24; continue; }
			/* */ $s = 25; continue;
			/* if (!_r$3) { */ case 24:
				$r = data.Swap(c, hi - 1 >> 0); /* */ $s = 27; case 27: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				c = c + (1) >> 0;
				dups = dups + (1) >> 0;
			/* } */ case 25:
			_r$4 = data.Less(b - 1 >> 0, pivot); /* */ $s = 30; case 30: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			/* */ if (!_r$4) { $s = 28; continue; }
			/* */ $s = 29; continue;
			/* if (!_r$4) { */ case 28:
				b = b - (1) >> 0;
				dups = dups + (1) >> 0;
			/* } */ case 29:
			_r$5 = data.Less(m, pivot); /* */ $s = 33; case 33: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
			/* */ if (!_r$5) { $s = 31; continue; }
			/* */ $s = 32; continue;
			/* if (!_r$5) { */ case 31:
				$r = data.Swap(m, b - 1 >> 0); /* */ $s = 34; case 34: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				b = b - (1) >> 0;
				dups = dups + (1) >> 0;
			/* } */ case 32:
			protect = dups > 1;
		/* } */ case 23:
		/* */ if (protect) { $s = 35; continue; }
		/* */ $s = 36; continue;
		/* if (protect) { */ case 35:
			/* while (true) { */ case 37:
				/* while (true) { */ case 39:
					if (!(a < b)) { _v$3 = false; $s = 41; continue s; }
					_r$6 = data.Less(b - 1 >> 0, pivot); /* */ $s = 42; case 42: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
					_v$3 = !_r$6; case 41:
					/* if (!(_v$3)) { break; } */ if(!(_v$3)) { $s = 40; continue; }
					b = b - (1) >> 0;
				$s = 39; continue;
				case 40:
				/* while (true) { */ case 43:
					if (!(a < b)) { _v$4 = false; $s = 45; continue s; }
					_r$7 = data.Less(a, pivot); /* */ $s = 46; case 46: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
					_v$4 = _r$7; case 45:
					/* if (!(_v$4)) { break; } */ if(!(_v$4)) { $s = 44; continue; }
					a = a + (1) >> 0;
				$s = 43; continue;
				case 44:
				if (a >= b) {
					/* break; */ $s = 38; continue;
				}
				$r = data.Swap(a, b - 1 >> 0); /* */ $s = 47; case 47: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				a = a + (1) >> 0;
				b = b - (1) >> 0;
			$s = 37; continue;
			case 38:
		/* } */ case 36:
		$r = data.Swap(pivot, b - 1 >> 0); /* */ $s = 48; case 48: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_tmp$2 = b - 1 >> 0;
		_tmp$3 = c;
		midlo = _tmp$2;
		midhi = _tmp$3;
		$s = -1; return [midlo, midhi];
		/* */ } return; } if ($f === undefined) { $f = { $blk: doPivot }; } $f._q = _q; $f._q$1 = _q$1; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f._r$3 = _r$3; $f._r$4 = _r$4; $f._r$5 = _r$5; $f._r$6 = _r$6; $f._r$7 = _r$7; $f._tmp = _tmp; $f._tmp$1 = _tmp$1; $f._tmp$2 = _tmp$2; $f._tmp$3 = _tmp$3; $f._v = _v; $f._v$1 = _v$1; $f._v$2 = _v$2; $f._v$3 = _v$3; $f._v$4 = _v$4; $f.a = a; $f.b = b; $f.c = c; $f.data = data; $f.dups = dups; $f.hi = hi; $f.lo = lo; $f.m = m; $f.midhi = midhi; $f.midlo = midlo; $f.pivot = pivot; $f.protect = protect; $f.s = s; $f.$s = $s; $f.$r = $r; return $f;
	};
	quickSort = function(data, a, b, maxDepth$1) {
		var _r, _r$1, _tuple, a, b, data, i, maxDepth$1, mhi, mlo, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; _tuple = $f._tuple; a = $f.a; b = $f.b; data = $f.data; i = $f.i; maxDepth$1 = $f.maxDepth$1; mhi = $f.mhi; mlo = $f.mlo; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* while (true) { */ case 1:
			/* if (!((b - a >> 0) > 12)) { break; } */ if(!((b - a >> 0) > 12)) { $s = 2; continue; }
			/* */ if (maxDepth$1 === 0) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (maxDepth$1 === 0) { */ case 3:
				$r = heapSort(data, a, b); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$s = -1; return;
			/* } */ case 4:
			maxDepth$1 = maxDepth$1 - (1) >> 0;
			_r = doPivot(data, a, b); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_tuple = _r;
			mlo = _tuple[0];
			mhi = _tuple[1];
			/* */ if ((mlo - a >> 0) < (b - mhi >> 0)) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if ((mlo - a >> 0) < (b - mhi >> 0)) { */ case 7:
				$r = quickSort(data, a, mlo, maxDepth$1); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				a = mhi;
				$s = 9; continue;
			/* } else { */ case 8:
				$r = quickSort(data, mhi, b, maxDepth$1); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				b = mlo;
			/* } */ case 9:
		$s = 1; continue;
		case 2:
		/* */ if ((b - a >> 0) > 1) { $s = 12; continue; }
		/* */ $s = 13; continue;
		/* if ((b - a >> 0) > 1) { */ case 12:
			i = a + 6 >> 0;
			/* while (true) { */ case 14:
				/* if (!(i < b)) { break; } */ if(!(i < b)) { $s = 15; continue; }
				_r$1 = data.Less(i, i - 6 >> 0); /* */ $s = 18; case 18: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				/* */ if (_r$1) { $s = 16; continue; }
				/* */ $s = 17; continue;
				/* if (_r$1) { */ case 16:
					$r = data.Swap(i, i - 6 >> 0); /* */ $s = 19; case 19: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				/* } */ case 17:
				i = i + (1) >> 0;
			$s = 14; continue;
			case 15:
			$r = insertionSort(data, a, b); /* */ $s = 20; case 20: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 13:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: quickSort }; } $f._r = _r; $f._r$1 = _r$1; $f._tuple = _tuple; $f.a = a; $f.b = b; $f.data = data; $f.i = i; $f.maxDepth$1 = maxDepth$1; $f.mhi = mhi; $f.mlo = mlo; $f.$s = $s; $f.$r = $r; return $f;
	};
	Sort = function(data) {
		var _r, data, n, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; data = $f.data; n = $f.n; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		_r = data.Len(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		n = _r;
		$r = quickSort(data, 0, n, maxDepth(n)); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Sort }; } $f._r = _r; $f.data = data; $f.n = n; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.Sort = Sort;
	maxDepth = function(n) {
		var depth, i, n;
		depth = 0;
		i = n;
		while (true) {
			if (!(i > 0)) { break; }
			depth = depth + (1) >> 0;
			i = (i >> $min((1), 31)) >> 0;
		}
		return $imul(depth, 2);
	};
	StringSlice.prototype.Len = function() {
		var x;
		x = this;
		return x.$length;
	};
	$ptrType(StringSlice).prototype.Len = function() { return this.$get().Len(); };
	StringSlice.prototype.Less = function(i, j) {
		var i, j, x;
		x = this;
		return ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]) < ((j < 0 || j >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + j]);
	};
	$ptrType(StringSlice).prototype.Less = function(i, j) { return this.$get().Less(i, j); };
	StringSlice.prototype.Swap = function(i, j) {
		var _tmp, _tmp$1, i, j, x;
		x = this;
		_tmp = ((j < 0 || j >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + j]);
		_tmp$1 = ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]);
		((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i] = _tmp);
		((j < 0 || j >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + j] = _tmp$1);
	};
	$ptrType(StringSlice).prototype.Swap = function(i, j) { return this.$get().Swap(i, j); };
	StringSlice.prototype.Sort = function() {
		var x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		x = this;
		$r = Sort(x); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: StringSlice.prototype.Sort }; } $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	$ptrType(StringSlice).prototype.Sort = function() { return this.$get().Sort(); };
	Strings = function(x) {
		var x, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; x = $f.x; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = Sort(($convertSliceType(x, StringSlice))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Strings }; } $f.x = x; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.Strings = Strings;
	insertionSort_func = function(data, a, b) {
		var _r, _v, a, b, data, i, j, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _v = $f._v; a = $f.a; b = $f.b; data = $f.data; i = $f.i; j = $f.j; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		i = a + 1 >> 0;
		/* while (true) { */ case 1:
			/* if (!(i < b)) { break; } */ if(!(i < b)) { $s = 2; continue; }
			j = i;
			/* while (true) { */ case 3:
				if (!(j > a)) { _v = false; $s = 5; continue s; }
				_r = data.Less(j, j - 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 5:
				/* if (!(_v)) { break; } */ if(!(_v)) { $s = 4; continue; }
				$r = data.Swap(j, j - 1 >> 0); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				j = j - (1) >> 0;
			$s = 3; continue;
			case 4:
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: insertionSort_func }; } $f._r = _r; $f._v = _v; $f.a = a; $f.b = b; $f.data = data; $f.i = i; $f.j = j; $f.$s = $s; $f.$r = $r; return $f;
	};
	swapRange_func = function(data, a, b, n) {
		var a, b, data, i, n, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; a = $f.a; b = $f.b; data = $f.data; i = $f.i; n = $f.n; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < n)) { break; } */ if(!(i < n)) { $s = 2; continue; }
			$r = data.Swap(a + i >> 0, b + i >> 0); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: swapRange_func }; } $f.a = a; $f.b = b; $f.data = data; $f.i = i; $f.n = n; $f.$s = $s; $f.$r = $r; return $f;
	};
	stable_func = function(data, n) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, a, b, blockSize, data, m, n, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _tmp = $f._tmp; _tmp$1 = $f._tmp$1; _tmp$2 = $f._tmp$2; _tmp$3 = $f._tmp$3; a = $f.a; b = $f.b; blockSize = $f.blockSize; data = $f.data; m = $f.m; n = $f.n; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		blockSize = 20;
		_tmp = 0;
		_tmp$1 = blockSize;
		a = _tmp;
		b = _tmp$1;
		/* while (true) { */ case 1:
			/* if (!(b <= n)) { break; } */ if(!(b <= n)) { $s = 2; continue; }
			$r = insertionSort_func($clone(data, lessSwap), a, b); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			a = b;
			b = b + (blockSize) >> 0;
		$s = 1; continue;
		case 2:
		$r = insertionSort_func($clone(data, lessSwap), a, n); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* while (true) { */ case 5:
			/* if (!(blockSize < n)) { break; } */ if(!(blockSize < n)) { $s = 6; continue; }
			_tmp$2 = 0;
			_tmp$3 = $imul(2, blockSize);
			a = _tmp$2;
			b = _tmp$3;
			/* while (true) { */ case 7:
				/* if (!(b <= n)) { break; } */ if(!(b <= n)) { $s = 8; continue; }
				$r = symMerge_func($clone(data, lessSwap), a, a + blockSize >> 0, b); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				a = b;
				b = b + (($imul(2, blockSize))) >> 0;
			$s = 7; continue;
			case 8:
			m = a + blockSize >> 0;
			/* */ if (m < n) { $s = 10; continue; }
			/* */ $s = 11; continue;
			/* if (m < n) { */ case 10:
				$r = symMerge_func($clone(data, lessSwap), a, m, n); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* } */ case 11:
			blockSize = $imul(blockSize, (2));
		$s = 5; continue;
		case 6:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: stable_func }; } $f._tmp = _tmp; $f._tmp$1 = _tmp$1; $f._tmp$2 = _tmp$2; $f._tmp$3 = _tmp$3; $f.a = a; $f.b = b; $f.blockSize = blockSize; $f.data = data; $f.m = m; $f.n = n; $f.$s = $s; $f.$r = $r; return $f;
	};
	symMerge_func = function(data, a, m, b) {
		var _r, _r$1, _r$2, _tmp, _tmp$1, a, b, c, data, end, h, h$1, i, i$1, j, j$1, k, k$1, m, mid, n, p, r, start, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; _tmp = $f._tmp; _tmp$1 = $f._tmp$1; a = $f.a; b = $f.b; c = $f.c; data = $f.data; end = $f.end; h = $f.h; h$1 = $f.h$1; i = $f.i; i$1 = $f.i$1; j = $f.j; j$1 = $f.j$1; k = $f.k; k$1 = $f.k$1; m = $f.m; mid = $f.mid; n = $f.n; p = $f.p; r = $f.r; start = $f.start; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ if ((m - a >> 0) === 1) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if ((m - a >> 0) === 1) { */ case 1:
			i = m;
			j = b;
			/* while (true) { */ case 3:
				/* if (!(i < j)) { break; } */ if(!(i < j)) { $s = 4; continue; }
				h = ((((((i + j >> 0) >>> 0)) >>> 1 >>> 0) >> 0));
				_r = data.Less(h, a); /* */ $s = 8; case 8: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				/* */ if (_r) { $s = 5; continue; }
				/* */ $s = 6; continue;
				/* if (_r) { */ case 5:
					i = h + 1 >> 0;
					$s = 7; continue;
				/* } else { */ case 6:
					j = h;
				/* } */ case 7:
			$s = 3; continue;
			case 4:
			k = a;
			/* while (true) { */ case 9:
				/* if (!(k < (i - 1 >> 0))) { break; } */ if(!(k < (i - 1 >> 0))) { $s = 10; continue; }
				$r = data.Swap(k, k + 1 >> 0); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				k = k + (1) >> 0;
			$s = 9; continue;
			case 10:
			$s = -1; return;
		/* } */ case 2:
		/* */ if ((b - m >> 0) === 1) { $s = 12; continue; }
		/* */ $s = 13; continue;
		/* if ((b - m >> 0) === 1) { */ case 12:
			i$1 = a;
			j$1 = m;
			/* while (true) { */ case 14:
				/* if (!(i$1 < j$1)) { break; } */ if(!(i$1 < j$1)) { $s = 15; continue; }
				h$1 = ((((((i$1 + j$1 >> 0) >>> 0)) >>> 1 >>> 0) >> 0));
				_r$1 = data.Less(m, h$1); /* */ $s = 19; case 19: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				/* */ if (!_r$1) { $s = 16; continue; }
				/* */ $s = 17; continue;
				/* if (!_r$1) { */ case 16:
					i$1 = h$1 + 1 >> 0;
					$s = 18; continue;
				/* } else { */ case 17:
					j$1 = h$1;
				/* } */ case 18:
			$s = 14; continue;
			case 15:
			k$1 = m;
			/* while (true) { */ case 20:
				/* if (!(k$1 > i$1)) { break; } */ if(!(k$1 > i$1)) { $s = 21; continue; }
				$r = data.Swap(k$1, k$1 - 1 >> 0); /* */ $s = 22; case 22: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				k$1 = k$1 - (1) >> 0;
			$s = 20; continue;
			case 21:
			$s = -1; return;
		/* } */ case 13:
		mid = ((((((a + b >> 0) >>> 0)) >>> 1 >>> 0) >> 0));
		n = mid + m >> 0;
		_tmp = 0;
		_tmp$1 = 0;
		start = _tmp;
		r = _tmp$1;
		if (m > mid) {
			start = n - b >> 0;
			r = mid;
		} else {
			start = a;
			r = m;
		}
		p = n - 1 >> 0;
		/* while (true) { */ case 23:
			/* if (!(start < r)) { break; } */ if(!(start < r)) { $s = 24; continue; }
			c = ((((((start + r >> 0) >>> 0)) >>> 1 >>> 0) >> 0));
			_r$2 = data.Less(p - c >> 0, c); /* */ $s = 28; case 28: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			/* */ if (!_r$2) { $s = 25; continue; }
			/* */ $s = 26; continue;
			/* if (!_r$2) { */ case 25:
				start = c + 1 >> 0;
				$s = 27; continue;
			/* } else { */ case 26:
				r = c;
			/* } */ case 27:
		$s = 23; continue;
		case 24:
		end = n - start >> 0;
		/* */ if (start < m && m < end) { $s = 29; continue; }
		/* */ $s = 30; continue;
		/* if (start < m && m < end) { */ case 29:
			$r = rotate_func($clone(data, lessSwap), start, m, end); /* */ $s = 31; case 31: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 30:
		/* */ if (a < start && start < mid) { $s = 32; continue; }
		/* */ $s = 33; continue;
		/* if (a < start && start < mid) { */ case 32:
			$r = symMerge_func($clone(data, lessSwap), a, start, mid); /* */ $s = 34; case 34: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 33:
		/* */ if (mid < end && end < b) { $s = 35; continue; }
		/* */ $s = 36; continue;
		/* if (mid < end && end < b) { */ case 35:
			$r = symMerge_func($clone(data, lessSwap), mid, end, b); /* */ $s = 37; case 37: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* } */ case 36:
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: symMerge_func }; } $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f._tmp = _tmp; $f._tmp$1 = _tmp$1; $f.a = a; $f.b = b; $f.c = c; $f.data = data; $f.end = end; $f.h = h; $f.h$1 = h$1; $f.i = i; $f.i$1 = i$1; $f.j = j; $f.j$1 = j$1; $f.k = k; $f.k$1 = k$1; $f.m = m; $f.mid = mid; $f.n = n; $f.p = p; $f.r = r; $f.start = start; $f.$s = $s; $f.$r = $r; return $f;
	};
	rotate_func = function(data, a, m, b) {
		var a, b, data, i, j, m, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; a = $f.a; b = $f.b; data = $f.data; i = $f.i; j = $f.j; m = $f.m; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		i = m - a >> 0;
		j = b - m >> 0;
		/* while (true) { */ case 1:
			/* if (!(!((i === j)))) { break; } */ if(!(!((i === j)))) { $s = 2; continue; }
			/* */ if (i > j) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (i > j) { */ case 3:
				$r = swapRange_func($clone(data, lessSwap), m - i >> 0, m, j); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				i = i - (j) >> 0;
				$s = 5; continue;
			/* } else { */ case 4:
				$r = swapRange_func($clone(data, lessSwap), m - i >> 0, (m + j >> 0) - i >> 0, i); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				j = j - (i) >> 0;
			/* } */ case 5:
		$s = 1; continue;
		case 2:
		$r = swapRange_func($clone(data, lessSwap), m - i >> 0, m, i); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } if ($f === undefined) { $f = { $blk: rotate_func }; } $f.a = a; $f.b = b; $f.data = data; $f.i = i; $f.j = j; $f.m = m; $f.$s = $s; $f.$r = $r; return $f;
	};
	StringSlice.methods = [{prop: "Search", name: "Search", pkg: "", typ: $funcType([$String], [$Int], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Less", name: "Less", pkg: "", typ: $funcType([$Int, $Int], [$Bool], false)}, {prop: "Swap", name: "Swap", pkg: "", typ: $funcType([$Int, $Int], [], false)}, {prop: "Sort", name: "Sort", pkg: "", typ: $funcType([], [], false)}];
	lessSwap.init("", [{prop: "Less", name: "Less", embedded: false, exported: true, typ: funcType, tag: ""}, {prop: "Swap", name: "Swap", embedded: false, exported: true, typ: funcType$1, tag: ""}]);
	StringSlice.init($String);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = reflectlite.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		reflectValueOf = reflectlite.ValueOf;
		reflectSwapper = reflectlite.Swapper;
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["github.com/jicksta/ranked-pairs-voting/internal"] = (function() {
	var $pkg = {}, $init, sort, sliceType, SortedUniques;
	sort = $packages["sort"];
	sliceType = $sliceType($String);
	SortedUniques = function(chanReceiver) {
		var Q, _1, _2, _entry, _i, _key, _keys, _r, _ref, _tuple, chanReceiver, key, set, str, strs, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; Q = $f.Q; _1 = $f._1; _2 = $f._2; _entry = $f._entry; _i = $f._i; _key = $f._key; _keys = $f._keys; _r = $f._r; _ref = $f._ref; _tuple = $f._tuple; chanReceiver = $f.chanReceiver; key = $f.key; set = $f.set; str = $f.str; strs = $f.strs; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		Q = [Q];
		chanReceiver = [chanReceiver];
		Q[0] = new $Chan($String, 0);
		$go((function(Q, chanReceiver) { return function $b() {
			var $s, $r;
			/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
			$r = chanReceiver[0](Q[0]); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$close(Q[0]);
			$s = -1; return;
			/* */ } return; } if ($f === undefined) { $f = { $blk: $b }; } $f.$s = $s; $f.$r = $r; return $f;
		}; })(Q, chanReceiver), []);
		set = {};
		_2 = Q[0];
		/* while (true) { */ case 1:
			_r = $recv(_2); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_tuple = _r;
			str = _tuple[0];
			_1 = _tuple[1];
			if (!_1) {
				/* break; */ $s = 2; continue;
			}
			_key = str; (set || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key)] = { k: _key, v: true };
		$s = 1; continue;
		case 2:
		strs = sliceType.nil;
		_ref = set;
		_i = 0;
		_keys = $keys(_ref);
		while (true) {
			if (!(_i < _keys.length)) { break; }
			_entry = _ref[_keys[_i]];
			if (_entry === undefined) {
				_i++;
				continue;
			}
			key = _entry.k;
			strs = $append(strs, key);
			_i++;
		}
		$r = sort.Strings(strs); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return strs;
		/* */ } return; } if ($f === undefined) { $f = { $blk: SortedUniques }; } $f.Q = Q; $f._1 = _1; $f._2 = _2; $f._entry = _entry; $f._i = _i; $f._key = _key; $f._keys = _keys; $f._r = _r; $f._ref = _ref; $f._tuple = _tuple; $f.chanReceiver = chanReceiver; $f.key = key; $f.set = set; $f.str = str; $f.strs = strs; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.SortedUniques = SortedUniques;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = sort.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["github.com/jicksta/ranked-pairs-voting"] = (function() {
	var $pkg = {}, $init, internal, sort, Vertex, Edge, SortedVertices, vertexMap, edgeMap, DAG, DAGCycleError, Ballot, Election, ElectionResults, RankablePair, RankedPairs, Tally, TallyMatrix, ptrType, ptrType$1, sliceType, ptrType$2, ptrType$3, sliceType$1, ptrType$4, ptrType$5, sliceType$2, sliceType$3, ptrType$6, ptrType$7, ptrType$8, ptrType$9, sliceType$4, sliceType$5, sliceType$6, ptrType$10, mapType, mapType$1, ptrType$11, sliceType$7, mapType$2, ptrType$12, ptrType$13, ptrType$15, ptrType$16, NewDAG, newTally, NewElection, orderStrings;
	internal = $packages["github.com/jicksta/ranked-pairs-voting/internal"];
	sort = $packages["sort"];
	Vertex = $pkg.Vertex = $newType(0, $kindStruct, "trp.Vertex", true, "github.com/jicksta/ranked-pairs-voting", true, function(ID_, degreeIn_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.ID = "";
			this.degreeIn = 0;
			return;
		}
		this.ID = ID_;
		this.degreeIn = degreeIn_;
	});
	Edge = $pkg.Edge = $newType(0, $kindStruct, "trp.Edge", true, "github.com/jicksta/ranked-pairs-voting", true, function(From_, To_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.From = ptrType$3.nil;
			this.To = ptrType$3.nil;
			return;
		}
		this.From = From_;
		this.To = To_;
	});
	SortedVertices = $pkg.SortedVertices = $newType(12, $kindSlice, "trp.SortedVertices", true, "github.com/jicksta/ranked-pairs-voting", true, null);
	vertexMap = $pkg.vertexMap = $newType(4, $kindMap, "trp.vertexMap", true, "github.com/jicksta/ranked-pairs-voting", false, null);
	edgeMap = $pkg.edgeMap = $newType(4, $kindMap, "trp.edgeMap", true, "github.com/jicksta/ranked-pairs-voting", false, null);
	DAG = $pkg.DAG = $newType(0, $kindStruct, "trp.DAG", true, "github.com/jicksta/ranked-pairs-voting", true, function(Vertices_, Edges_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Vertices = ptrType.nil;
			this.Edges = ptrType$1.nil;
			return;
		}
		this.Vertices = Vertices_;
		this.Edges = Edges_;
	});
	DAGCycleError = $pkg.DAGCycleError = $newType(0, $kindStruct, "trp.DAGCycleError", true, "github.com/jicksta/ranked-pairs-voting", true, function() {
		this.$val = this;
		if (arguments.length === 0) {
			return;
		}
	});
	Ballot = $pkg.Ballot = $newType(0, $kindStruct, "trp.Ballot", true, "github.com/jicksta/ranked-pairs-voting", true, function(VoterID_, Priorities_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.VoterID = "";
			this.Priorities = sliceType$3.nil;
			return;
		}
		this.VoterID = VoterID_;
		this.Priorities = Priorities_;
	});
	Election = $pkg.Election = $newType(0, $kindStruct, "trp.Election", true, "github.com/jicksta/ranked-pairs-voting", true, function(ElectionID_, Ballots_, Choices_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.ElectionID = "";
			this.Ballots = sliceType$2.nil;
			this.Choices = sliceType.nil;
			return;
		}
		this.ElectionID = ElectionID_;
		this.Ballots = Ballots_;
		this.Choices = Choices_;
	});
	ElectionResults = $pkg.ElectionResults = $newType(0, $kindStruct, "trp.ElectionResults", true, "github.com/jicksta/ranked-pairs-voting", true, function(Election_, Tally_, RankedPairs_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Election = ptrType$6.nil;
			this.Tally = ptrType$7.nil;
			this.RankedPairs = ptrType$8.nil;
			return;
		}
		this.Election = Election_;
		this.Tally = Tally_;
		this.RankedPairs = RankedPairs_;
	});
	RankablePair = $pkg.RankablePair = $newType(0, $kindStruct, "trp.RankablePair", true, "github.com/jicksta/ranked-pairs-voting", true, function(A_, B_, FavorA_, FavorB_, Ties_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.A = "";
			this.B = "";
			this.FavorA = new $Int64(0, 0);
			this.FavorB = new $Int64(0, 0);
			this.Ties = new $Int64(0, 0);
			return;
		}
		this.A = A_;
		this.B = B_;
		this.FavorA = FavorA_;
		this.FavorB = FavorB_;
		this.Ties = Ties_;
	});
	RankedPairs = $pkg.RankedPairs = $newType(0, $kindStruct, "trp.RankedPairs", true, "github.com/jicksta/ranked-pairs-voting", true, function(Winners_, LockedPairs_, CyclicalLockedPairsIndices_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Winners = sliceType$3.nil;
			this.LockedPairs = ptrType$10.nil;
			this.CyclicalLockedPairsIndices = sliceType$5.nil;
			return;
		}
		this.Winners = Winners_;
		this.LockedPairs = LockedPairs_;
		this.CyclicalLockedPairsIndices = CyclicalLockedPairsIndices_;
	});
	Tally = $pkg.Tally = $newType(0, $kindStruct, "trp.Tally", true, "github.com/jicksta/ranked-pairs-voting", true, function(pairs_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.pairs = ptrType$11.nil;
			return;
		}
		this.pairs = pairs_;
	});
	TallyMatrix = $pkg.TallyMatrix = $newType(0, $kindStruct, "trp.TallyMatrix", true, "github.com/jicksta/ranked-pairs-voting", true, function(Headings_, RowsColumns_, Tally_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Headings = sliceType.nil;
			this.RowsColumns = sliceType$7.nil;
			this.Tally = ptrType$7.nil;
			return;
		}
		this.Headings = Headings_;
		this.RowsColumns = RowsColumns_;
		this.Tally = Tally_;
	});
	ptrType = $ptrType(vertexMap);
	ptrType$1 = $ptrType(edgeMap);
	sliceType = $sliceType($String);
	ptrType$2 = $ptrType(Edge);
	ptrType$3 = $ptrType(Vertex);
	sliceType$1 = $sliceType(ptrType$3);
	ptrType$4 = $ptrType(SortedVertices);
	ptrType$5 = $ptrType(Ballot);
	sliceType$2 = $sliceType(ptrType$5);
	sliceType$3 = $sliceType(sliceType);
	ptrType$6 = $ptrType(Election);
	ptrType$7 = $ptrType(Tally);
	ptrType$8 = $ptrType(RankedPairs);
	ptrType$9 = $ptrType(RankablePair);
	sliceType$4 = $sliceType(ptrType$9);
	sliceType$5 = $sliceType($Int);
	sliceType$6 = $sliceType(RankablePair);
	ptrType$10 = $ptrType(sliceType$6);
	mapType = $mapType($String, ptrType$9);
	mapType$1 = $mapType($String, mapType);
	ptrType$11 = $ptrType(mapType$1);
	sliceType$7 = $sliceType(sliceType$4);
	mapType$2 = $mapType($String, ptrType$2);
	ptrType$12 = $ptrType(DAG);
	ptrType$13 = $ptrType(DAGCycleError);
	ptrType$15 = $ptrType(ElectionResults);
	ptrType$16 = $ptrType(TallyMatrix);
	NewDAG = function() {
		var e, e$24ptr, v, v$24ptr;
		v = {};
		e = {};
		return new DAG.ptr((v$24ptr || (v$24ptr = new ptrType(function() { return v; }, function($v) { v = $v; }))), (e$24ptr || (e$24ptr = new ptrType$1(function() { return e; }, function($v) { e = $v; }))));
	};
	$pkg.NewDAG = NewDAG;
	$ptrType(SortedVertices).prototype.IDs = function() {
		var _i, _ref, ids, sorted, vertex;
		sorted = this;
		ids = sliceType.nil;
		_ref = sorted.$get();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			vertex = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			ids = $append(ids, vertex.ID);
			_i++;
		}
		return ids;
	};
	DAG.ptr.prototype.HasEdgeFromTo = function(fromID, toID) {
		var _entry, _entry$1, dag, fromID, fromMap, toID;
		dag = this;
		fromMap = (_entry = (dag.Edges.$get())[$String.keyFor(fromID)], _entry !== undefined ? _entry.v : false);
		if (fromMap === false) {
			return false;
		}
		return !((_entry$1 = fromMap[$String.keyFor(toID)], _entry$1 !== undefined ? _entry$1.v : ptrType$2.nil) === ptrType$2.nil);
	};
	DAG.prototype.HasEdgeFromTo = function(fromID, toID) { return this.$val.HasEdgeFromTo(fromID, toID); };
	DAG.ptr.prototype.AddEdge = function(from, to) {
		var _entry, _entry$1, _entry$2, _key, _key$1, _key$2, _tuple, dag, err, from, fromEdges, to, vFrom, vTo;
		dag = this;
		if (dag.HasEdgeFromTo(from, to)) {
			return $ifaceNil;
		}
		vFrom = dag.getOrCreateVertex(from);
		vTo = dag.getOrCreateVertex(to);
		fromEdges = (_entry = (dag.Edges.$get())[$String.keyFor(from)], _entry !== undefined ? _entry.v : false);
		if (fromEdges === false) {
			fromEdges = {};
			_key = to; (fromEdges || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key)] = { k: _key, v: dag.makeEdge(vFrom, vTo) };
			_key$1 = from; (dag.Edges.$get() || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key$1)] = { k: _key$1, v: fromEdges };
		} else if ((_entry$1 = fromEdges[$String.keyFor(to)], _entry$1 !== undefined ? _entry$1.v : ptrType$2.nil) === ptrType$2.nil) {
			_key$2 = to; (fromEdges || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key$2)] = { k: _key$2, v: dag.makeEdge(vFrom, vTo) };
		} else {
		}
		_tuple = dag.kahn();
		err = _tuple[1];
		if (!($interfaceIsEqual(err, $ifaceNil))) {
			vTo.degreeIn = vTo.degreeIn - (1) >> 0;
			delete (_entry$2 = (dag.Edges.$get())[$String.keyFor(from)], _entry$2 !== undefined ? _entry$2.v : false)[$String.keyFor(to)];
			return err;
		}
		return $ifaceNil;
	};
	DAG.prototype.AddEdge = function(from, to) { return this.$val.AddEdge(from, to); };
	DAG.ptr.prototype.TSort = function() {
		var _tuple, dag, results;
		dag = this;
		_tuple = dag.kahn();
		results = _tuple[0];
		return results;
	};
	DAG.prototype.TSort = function() { return this.$val.TSort(); };
	DAG.ptr.prototype.kahn = function() {
		var _entry, _entry$1, _entry$2, _entry$3, _entry$4, _i, _i$1, _key, _key$1, _keys, _keys$1, _ref, _ref$1, dag, edge, inDegrees, nextRoot, numVertices, numVerticesVisited, rootVertices, sortedVertices, sortedVertices$24ptr, vertex;
		dag = this;
		numVertices = $keys(dag.Vertices.$get()).length;
		inDegrees = ((numVertices < 0 || numVertices > 2147483647) ? $throwRuntimeError("makemap: size out of range") : {});
		rootVertices = sliceType$1.nil;
		_ref = dag.Vertices.$get();
		_i = 0;
		_keys = $keys(_ref);
		while (true) {
			if (!(_i < _keys.length)) { break; }
			_entry = _ref[_keys[_i]];
			if (_entry === undefined) {
				_i++;
				continue;
			}
			vertex = _entry.v;
			_key = vertex; (inDegrees || $throwRuntimeError("assignment to entry in nil map"))[ptrType$3.keyFor(_key)] = { k: _key, v: vertex.degreeIn };
			if (vertex.degreeIn === 0) {
				rootVertices = $append(rootVertices, vertex);
			}
			_i++;
		}
		sortedVertices = SortedVertices.nil;
		numVerticesVisited = 0;
		while (true) {
			if (!(rootVertices.$length > 0)) { break; }
			nextRoot = (0 >= rootVertices.$length ? ($throwRuntimeError("index out of range"), undefined) : rootVertices.$array[rootVertices.$offset + 0]);
			rootVertices = $subslice(rootVertices, 1);
			sortedVertices = $append(sortedVertices, nextRoot);
			_ref$1 = (_entry$1 = (dag.Edges.$get())[$String.keyFor(nextRoot.ID)], _entry$1 !== undefined ? _entry$1.v : false);
			_i$1 = 0;
			_keys$1 = $keys(_ref$1);
			while (true) {
				if (!(_i$1 < _keys$1.length)) { break; }
				_entry$2 = _ref$1[_keys$1[_i$1]];
				if (_entry$2 === undefined) {
					_i$1++;
					continue;
				}
				edge = _entry$2.v;
				_key$1 = edge.To; (inDegrees || $throwRuntimeError("assignment to entry in nil map"))[ptrType$3.keyFor(_key$1)] = { k: _key$1, v: (_entry$3 = inDegrees[ptrType$3.keyFor(edge.To)], _entry$3 !== undefined ? _entry$3.v : 0) - (1) >> 0 };
				if ((_entry$4 = inDegrees[ptrType$3.keyFor(edge.To)], _entry$4 !== undefined ? _entry$4.v : 0) === 0) {
					rootVertices = $append(rootVertices, edge.To);
				}
				_i$1++;
			}
			numVerticesVisited = numVerticesVisited + (1) >> 0;
		}
		if (!((numVerticesVisited === numVertices))) {
			return [ptrType$4.nil, new DAGCycleError.ptr()];
		}
		return [(sortedVertices$24ptr || (sortedVertices$24ptr = new ptrType$4(function() { return sortedVertices; }, function($v) { sortedVertices = $convertSliceType($v, SortedVertices); }))), $ifaceNil];
	};
	DAG.prototype.kahn = function() { return this.$val.kahn(); };
	DAG.ptr.prototype.getOrCreateVertex = function(vertexID) {
		var _entry, _key, dag, existingVertex, newVertex, vertexID;
		dag = this;
		existingVertex = (_entry = (dag.Vertices.$get())[$String.keyFor(vertexID)], _entry !== undefined ? _entry.v : ptrType$3.nil);
		if (!(existingVertex === ptrType$3.nil)) {
			return existingVertex;
		} else {
			newVertex = new Vertex.ptr(vertexID, 0);
			_key = vertexID; (dag.Vertices.$get() || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key)] = { k: _key, v: newVertex };
			return newVertex;
		}
	};
	DAG.prototype.getOrCreateVertex = function(vertexID) { return this.$val.getOrCreateVertex(vertexID); };
	DAG.ptr.prototype.makeEdge = function(from, to) {
		var from, to;
		to.degreeIn = to.degreeIn + (1) >> 0;
		return new Edge.ptr(from, to);
	};
	DAG.prototype.makeEdge = function(from, to) { return this.$val.makeEdge(from, to); };
	DAGCycleError.ptr.prototype.Error = function() {
		var e;
		e = this;
		return "CYCLE";
	};
	DAGCycleError.prototype.Error = function() { return this.$val.Error(); };
	Election.ptr.prototype.Results = function() {
		var _r, e, rankedPairs, tally, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; e = $f.e; rankedPairs = $f.rankedPairs; tally = $f.tally; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		e = this;
		tally = e.TallyBallots();
		_r = tally.RankedPairs(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rankedPairs = _r;
		$s = -1; return new ElectionResults.ptr(e, tally, rankedPairs);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Election.ptr.prototype.Results }; } $f._r = _r; $f.e = e; $f.rankedPairs = rankedPairs; $f.tally = tally; $f.$s = $s; $f.$r = $r; return $f;
	};
	Election.prototype.Results = function() { return this.$val.Results(); };
	ElectionResults.ptr.prototype.Winners = function() {
		var r;
		r = this;
		return r.RankedPairs.Winners;
	};
	ElectionResults.prototype.Winners = function() { return this.$val.Winners(); };
	Election.ptr.prototype.TallyBallots = function() {
		var _i, _i$1, _ref, _ref$1, ballot, ballotRankedPair, e, t, x;
		e = this;
		t = newTally();
		_ref = e.Ballots;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			ballot = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_ref$1 = ballot.Runoffs();
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				ballotRankedPair = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
				if ((x = ballotRankedPair.Ties, (x.$high === 0 && x.$low === 1))) {
					t.incrementTies(ballotRankedPair.A, ballotRankedPair.B);
				} else {
					t.incrementWinner(ballotRankedPair.A, ballotRankedPair.B);
				}
				_i$1++;
			}
			_i++;
		}
		return t;
	};
	Election.prototype.TallyBallots = function() { return this.$val.TallyBallots(); };
	Ballot.ptr.prototype.Runoffs = function() {
		var _i, _i$1, _i$2, _i$3, _ref, _ref$1, _ref$2, _ref$3, ballot, choiceOuter, eachLosingChoiceOfSamePriority, eachWinningChoiceOfSamePriority, indexInner, indexOuter, result, tieInnerIndex, tieOuterIndex, x;
		ballot = this;
		result = sliceType$4.nil;
		_ref = ballot.Priorities;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			indexOuter = _i;
			choiceOuter = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_ref$1 = choiceOuter;
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				tieOuterIndex = _i$1;
				tieInnerIndex = tieOuterIndex + 1 >> 0;
				while (true) {
					if (!(tieInnerIndex < choiceOuter.$length)) { break; }
					result = $append(result, new RankablePair.ptr(((tieOuterIndex < 0 || tieOuterIndex >= choiceOuter.$length) ? ($throwRuntimeError("index out of range"), undefined) : choiceOuter.$array[choiceOuter.$offset + tieOuterIndex]), ((tieInnerIndex < 0 || tieInnerIndex >= choiceOuter.$length) ? ($throwRuntimeError("index out of range"), undefined) : choiceOuter.$array[choiceOuter.$offset + tieInnerIndex]), new $Int64(0, 0), new $Int64(0, 0), new $Int64(0, 1)));
					tieInnerIndex = tieInnerIndex + (1) >> 0;
				}
				_i$1++;
			}
			indexInner = indexOuter + 1 >> 0;
			while (true) {
				if (!(indexInner < ballot.Priorities.$length)) { break; }
				_ref$2 = choiceOuter;
				_i$2 = 0;
				while (true) {
					if (!(_i$2 < _ref$2.$length)) { break; }
					eachWinningChoiceOfSamePriority = ((_i$2 < 0 || _i$2 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$2]);
					_ref$3 = (x = ballot.Priorities, ((indexInner < 0 || indexInner >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + indexInner]));
					_i$3 = 0;
					while (true) {
						if (!(_i$3 < _ref$3.$length)) { break; }
						eachLosingChoiceOfSamePriority = ((_i$3 < 0 || _i$3 >= _ref$3.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$3.$array[_ref$3.$offset + _i$3]);
						result = $append(result, new RankablePair.ptr(eachWinningChoiceOfSamePriority, eachLosingChoiceOfSamePriority, new $Int64(0, 1), new $Int64(0, 0), new $Int64(0, 0)));
						_i$3++;
					}
					_i$2++;
				}
				indexInner = indexInner + (1) >> 0;
			}
			_i++;
		}
		return result;
	};
	Ballot.prototype.Runoffs = function() { return this.$val.Runoffs(); };
	RankablePair.ptr.prototype.VictoryMagnitude = function() {
		var delta, pair, x, x$1;
		pair = this;
		delta = (x = pair.FavorA, x$1 = pair.FavorB, new $Int64(x.$high - x$1.$high, x.$low - x$1.$low));
		if ((delta.$high < 0 || (delta.$high === 0 && delta.$low < 0))) {
			delta = new $Int64(-delta.$high, -delta.$low);
		}
		return delta;
	};
	RankablePair.prototype.VictoryMagnitude = function() { return this.$val.VictoryMagnitude(); };
	Tally.ptr.prototype.RankedPairs = function() {
		var _i, _i$1, _i$2, _r, _r$1, _ref, _ref$1, _ref$2, choice, choiceInSortedWinners, cycles, dag, err, err$1, groupedWinners, i, i$1, lastIndexWithSameRank, lastPlaceGroup, lockedPairs, pair, pair$1, sameRankGroup, sortedWinner, sortedWinners, t, x, x$1, x$2, x$3, x$4, x$5, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _i = $f._i; _i$1 = $f._i$1; _i$2 = $f._i$2; _r = $f._r; _r$1 = $f._r$1; _ref = $f._ref; _ref$1 = $f._ref$1; _ref$2 = $f._ref$2; choice = $f.choice; choiceInSortedWinners = $f.choiceInSortedWinners; cycles = $f.cycles; dag = $f.dag; err = $f.err; err$1 = $f.err$1; groupedWinners = $f.groupedWinners; i = $f.i; i$1 = $f.i$1; lastIndexWithSameRank = $f.lastIndexWithSameRank; lastPlaceGroup = $f.lastPlaceGroup; lockedPairs = $f.lockedPairs; pair = $f.pair; pair$1 = $f.pair$1; sameRankGroup = $f.sameRankGroup; sortedWinner = $f.sortedWinner; sortedWinners = $f.sortedWinners; t = $f.t; x = $f.x; x$1 = $f.x$1; x$2 = $f.x$2; x$3 = $f.x$3; x$4 = $f.x$4; x$5 = $f.x$5; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		t = this;
		_r = t.lockedPairs(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		lockedPairs = _r;
		dag = NewDAG();
		cycles = sliceType$5.nil;
		_ref = lockedPairs.$get();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			pair = $clone(((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]), RankablePair);
			if ((x = pair.FavorA, x$1 = pair.FavorB, (x.$high > x$1.$high || (x.$high === x$1.$high && x.$low > x$1.$low)))) {
				err = dag.AddEdge(pair.A, pair.B);
				if (!($interfaceIsEqual(err, $ifaceNil))) {
					cycles = $append(cycles, i);
				}
			} else if ((x$2 = pair.FavorB, x$3 = pair.FavorA, (x$2.$high > x$3.$high || (x$2.$high === x$3.$high && x$2.$low > x$3.$low)))) {
				err$1 = dag.AddEdge(pair.B, pair.A);
				if (!($interfaceIsEqual(err$1, $ifaceNil))) {
					cycles = $append(cycles, i);
				}
			} else {
				cycles = $append(cycles, i);
			}
			_i++;
		}
		sortedWinners = dag.TSort().IDs();
		lastPlaceGroup = sliceType.nil;
		_r$1 = t.knownChoices(); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_ref$1 = _r$1;
		_i$1 = 0;
		/* while (true) { */ case 3:
			/* if (!(_i$1 < _ref$1.$length)) { break; } */ if(!(_i$1 < _ref$1.$length)) { $s = 4; continue; }
			choice = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			choiceInSortedWinners = false;
			_ref$2 = sortedWinners;
			_i$2 = 0;
			while (true) {
				if (!(_i$2 < _ref$2.$length)) { break; }
				sortedWinner = ((_i$2 < 0 || _i$2 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$2]);
				if (sortedWinner === choice) {
					choiceInSortedWinners = true;
					break;
				}
				_i$2++;
			}
			if (!choiceInSortedWinners) {
				lastPlaceGroup = $append(lastPlaceGroup, choice);
			}
			_i$1++;
		$s = 3; continue;
		case 4:
		groupedWinners = $makeSlice(sliceType$3, 0, sortedWinners.$length);
		/* while (true) { */ case 5:
			/* if (!(sortedWinners.$length > 0)) { break; } */ if(!(sortedWinners.$length > 0)) { $s = 6; continue; }
			lastIndexWithSameRank = 0;
			i$1 = 1;
			while (true) {
				if (!(i$1 < sortedWinners.$length)) { break; }
				pair$1 = t.GetPair((0 >= sortedWinners.$length ? ($throwRuntimeError("index out of range"), undefined) : sortedWinners.$array[sortedWinners.$offset + 0]), ((i$1 < 0 || i$1 >= sortedWinners.$length) ? ($throwRuntimeError("index out of range"), undefined) : sortedWinners.$array[sortedWinners.$offset + i$1]));
				if ((x$4 = pair$1.FavorA, x$5 = pair$1.FavorB, (x$4.$high === x$5.$high && x$4.$low === x$5.$low))) {
					lastIndexWithSameRank = i$1;
				} else {
					break;
				}
				i$1 = i$1 + (1) >> 0;
			}
			sameRankGroup = $subslice(sortedWinners, 0, (1 + lastIndexWithSameRank >> 0));
			$r = sort.Strings(sameRankGroup); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			groupedWinners = $append(groupedWinners, sameRankGroup);
			sortedWinners = $subslice(sortedWinners, (1 + lastIndexWithSameRank >> 0));
		$s = 5; continue;
		case 6:
		/* */ if (lastPlaceGroup.$length > 0) { $s = 8; continue; }
		/* */ $s = 9; continue;
		/* if (lastPlaceGroup.$length > 0) { */ case 8:
			$r = sort.Strings(lastPlaceGroup); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			groupedWinners = $append(groupedWinners, lastPlaceGroup);
		/* } */ case 9:
		$s = -1; return new RankedPairs.ptr(groupedWinners, lockedPairs, cycles);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Tally.ptr.prototype.RankedPairs }; } $f._i = _i; $f._i$1 = _i$1; $f._i$2 = _i$2; $f._r = _r; $f._r$1 = _r$1; $f._ref = _ref; $f._ref$1 = _ref$1; $f._ref$2 = _ref$2; $f.choice = choice; $f.choiceInSortedWinners = choiceInSortedWinners; $f.cycles = cycles; $f.dag = dag; $f.err = err; $f.err$1 = err$1; $f.groupedWinners = groupedWinners; $f.i = i; $f.i$1 = i$1; $f.lastIndexWithSameRank = lastIndexWithSameRank; $f.lastPlaceGroup = lastPlaceGroup; $f.lockedPairs = lockedPairs; $f.pair = pair; $f.pair$1 = pair$1; $f.sameRankGroup = sameRankGroup; $f.sortedWinner = sortedWinner; $f.sortedWinners = sortedWinners; $f.t = t; $f.x = x; $f.x$1 = x$1; $f.x$2 = x$2; $f.x$3 = x$3; $f.x$4 = x$4; $f.x$5 = x$5; $f.$s = $s; $f.$r = $r; return $f;
	};
	Tally.prototype.RankedPairs = function() { return this.$val.RankedPairs(); };
	newTally = function() {
		var pairs, pairs$24ptr;
		pairs = {};
		return new Tally.ptr((pairs$24ptr || (pairs$24ptr = new ptrType$11(function() { return pairs; }, function($v) { pairs = $v; }))));
	};
	Tally.ptr.prototype.lockedPairs = function() {
		var _entry, _entry$1, _entry$2, _entry$3, _entry$4, _i, _i$1, _i$2, _keys, _keys$1, _ref, _ref$1, _ref$2, aKey, bKey, i, pair, result, t, x, x$1, x$2, x$3, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _entry = $f._entry; _entry$1 = $f._entry$1; _entry$2 = $f._entry$2; _entry$3 = $f._entry$3; _entry$4 = $f._entry$4; _i = $f._i; _i$1 = $f._i$1; _i$2 = $f._i$2; _keys = $f._keys; _keys$1 = $f._keys$1; _ref = $f._ref; _ref$1 = $f._ref$1; _ref$2 = $f._ref$2; aKey = $f.aKey; bKey = $f.bKey; i = $f.i; pair = $f.pair; result = $f.result; t = $f.t; x = $f.x; x$1 = $f.x$1; x$2 = $f.x$2; x$3 = $f.x$3; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		result = [result];
		t = this;
		result[0] = sliceType$6.nil;
		_ref = t.pairs.$get();
		_i = 0;
		_keys = $keys(_ref);
		while (true) {
			if (!(_i < _keys.length)) { break; }
			_entry = _ref[_keys[_i]];
			if (_entry === undefined) {
				_i++;
				continue;
			}
			aKey = _entry.k;
			_ref$1 = (_entry$1 = (t.pairs.$get())[$String.keyFor(aKey)], _entry$1 !== undefined ? _entry$1.v : false);
			_i$1 = 0;
			_keys$1 = $keys(_ref$1);
			while (true) {
				if (!(_i$1 < _keys$1.length)) { break; }
				_entry$2 = _ref$1[_keys$1[_i$1]];
				if (_entry$2 === undefined) {
					_i$1++;
					continue;
				}
				bKey = _entry$2.k;
				result[0] = $append(result[0], (_entry$3 = (_entry$4 = (t.pairs.$get())[$String.keyFor(aKey)], _entry$4 !== undefined ? _entry$4.v : false)[$String.keyFor(bKey)], _entry$3 !== undefined ? _entry$3.v : ptrType$9.nil));
				_i$1++;
			}
			_i++;
		}
		_ref$2 = result[0];
		_i$2 = 0;
		while (true) {
			if (!(_i$2 < _ref$2.$length)) { break; }
			i = _i$2;
			pair = $clone(((_i$2 < 0 || _i$2 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$2]), RankablePair);
			pair.FavorA = (x = pair.FavorA, x$1 = pair.Ties, new $Int64(x.$high + x$1.$high, x.$low + x$1.$low));
			pair.FavorB = (x$2 = pair.FavorB, x$3 = pair.Ties, new $Int64(x$2.$high + x$3.$high, x$2.$low + x$3.$low));
			RankablePair.copy(((i < 0 || i >= result[0].$length) ? ($throwRuntimeError("index out of range"), undefined) : result[0].$array[result[0].$offset + i]), pair);
			_i$2++;
		}
		$r = sort.SliceStable(result[0], (function(result) { return function(i$1, j) {
			var _tmp, _tmp$1, i$1, j, left, right, x$4, x$5;
			_tmp = $clone(((i$1 < 0 || i$1 >= result[0].$length) ? ($throwRuntimeError("index out of range"), undefined) : result[0].$array[result[0].$offset + i$1]), RankablePair);
			_tmp$1 = $clone(((j < 0 || j >= result[0].$length) ? ($throwRuntimeError("index out of range"), undefined) : result[0].$array[result[0].$offset + j]), RankablePair);
			left = $clone(_tmp, RankablePair);
			right = $clone(_tmp$1, RankablePair);
			return (x$4 = left.VictoryMagnitude(), x$5 = right.VictoryMagnitude(), (x$4.$high > x$5.$high || (x$4.$high === x$5.$high && x$4.$low >= x$5.$low)));
		}; })(result)); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return (result.$ptr || (result.$ptr = new ptrType$10(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, result)));
		/* */ } return; } if ($f === undefined) { $f = { $blk: Tally.ptr.prototype.lockedPairs }; } $f._entry = _entry; $f._entry$1 = _entry$1; $f._entry$2 = _entry$2; $f._entry$3 = _entry$3; $f._entry$4 = _entry$4; $f._i = _i; $f._i$1 = _i$1; $f._i$2 = _i$2; $f._keys = _keys; $f._keys$1 = _keys$1; $f._ref = _ref; $f._ref$1 = _ref$1; $f._ref$2 = _ref$2; $f.aKey = aKey; $f.bKey = bKey; $f.i = i; $f.pair = pair; $f.result = result; $f.t = t; $f.x = x; $f.x$1 = x$1; $f.x$2 = x$2; $f.x$3 = x$3; $f.$s = $s; $f.$r = $r; return $f;
	};
	Tally.prototype.lockedPairs = function() { return this.$val.lockedPairs(); };
	Tally.ptr.prototype.GetPair = function(first, second) {
		var _entry, _entry$1, _entry$2, _entry$3, _key, _key$1, _tuple, _tuple$1, a, b, exists, first, pair, second, t;
		t = this;
		_tuple = orderStrings(first, second);
		a = _tuple[0];
		b = _tuple[1];
		_tuple$1 = (_entry = (t.pairs.$get())[$String.keyFor(a)], _entry !== undefined ? [_entry.v, true] : [false, false]);
		exists = _tuple$1[1];
		if (!exists) {
			_key = a; (t.pairs.$get() || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key)] = { k: _key, v: $makeMap($String.keyFor, []) };
		}
		pair = (_entry$1 = (_entry$2 = (t.pairs.$get())[$String.keyFor(a)], _entry$2 !== undefined ? _entry$2.v : false)[$String.keyFor(b)], _entry$1 !== undefined ? _entry$1.v : ptrType$9.nil);
		if (pair === ptrType$9.nil) {
			pair = new RankablePair.ptr(a, b, new $Int64(0, 0), new $Int64(0, 0), new $Int64(0, 0));
			_key$1 = b; ((_entry$3 = (t.pairs.$get())[$String.keyFor(a)], _entry$3 !== undefined ? _entry$3.v : false) || $throwRuntimeError("assignment to entry in nil map"))[$String.keyFor(_key$1)] = { k: _key$1, v: pair };
		}
		return pair;
	};
	Tally.prototype.GetPair = function(first, second) { return this.$val.GetPair(first, second); };
	Tally.ptr.prototype.incrementWinner = function(winner, loser) {
		var loser, pair, t, winner, x, x$1, x$2, x$3;
		t = this;
		pair = t.GetPair(winner, loser);
		if (pair.A === winner) {
			pair.FavorA = (x = pair.FavorA, x$1 = new $Int64(0, 1), new $Int64(x.$high + x$1.$high, x.$low + x$1.$low));
		} else if (pair.B === winner) {
			pair.FavorB = (x$2 = pair.FavorB, x$3 = new $Int64(0, 1), new $Int64(x$2.$high + x$3.$high, x$2.$low + x$3.$low));
		} else {
			$panic(new $String("invalid winner string given " + winner + " for pair with A=" + pair.A + " and B=" + pair.B));
		}
	};
	Tally.prototype.incrementWinner = function(winner, loser) { return this.$val.incrementWinner(winner, loser); };
	Tally.ptr.prototype.incrementTies = function(first, second) {
		var _struct, first, second, t, x, x$1;
		t = this;
		_struct = t.GetPair(first, second);
		_struct.Ties = (x = _struct.Ties, x$1 = new $Int64(0, 1), new $Int64(x.$high + x$1.$high, x.$low + x$1.$low));
	};
	Tally.prototype.incrementTies = function(first, second) { return this.$val.incrementTies(first, second); };
	Tally.ptr.prototype.knownChoices = function() {
		var $24r, _r, t, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _r = $f._r; t = $f.t; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		t = [t];
		t[0] = this;
		_r = internal.SortedUniques((function(t) { return function $b(q) {
			var _entry, _entry$1, _entry$2, _i, _i$1, _keys, _keys$1, _ref, _ref$1, innerKey, outerKey, q, $s, $r;
			/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _entry = $f._entry; _entry$1 = $f._entry$1; _entry$2 = $f._entry$2; _i = $f._i; _i$1 = $f._i$1; _keys = $f._keys; _keys$1 = $f._keys$1; _ref = $f._ref; _ref$1 = $f._ref$1; innerKey = $f.innerKey; outerKey = $f.outerKey; q = $f.q; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
			_ref = t[0].pairs.$get();
			_i = 0;
			_keys = $keys(_ref);
			/* while (true) { */ case 1:
				/* if (!(_i < _keys.length)) { break; } */ if(!(_i < _keys.length)) { $s = 2; continue; }
				_entry = _ref[_keys[_i]];
				if (_entry === undefined) {
					_i++;
					/* continue; */ $s = 1; continue;
				}
				outerKey = _entry.k;
				$r = $send(q, outerKey); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				_ref$1 = (_entry$1 = (t[0].pairs.$get())[$String.keyFor(outerKey)], _entry$1 !== undefined ? _entry$1.v : false);
				_i$1 = 0;
				_keys$1 = $keys(_ref$1);
				/* while (true) { */ case 4:
					/* if (!(_i$1 < _keys$1.length)) { break; } */ if(!(_i$1 < _keys$1.length)) { $s = 5; continue; }
					_entry$2 = _ref$1[_keys$1[_i$1]];
					if (_entry$2 === undefined) {
						_i$1++;
						/* continue; */ $s = 4; continue;
					}
					innerKey = _entry$2.k;
					$r = $send(q, innerKey); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					_i$1++;
				$s = 4; continue;
				case 5:
				_i++;
			$s = 1; continue;
			case 2:
			$s = -1; return;
			/* */ } return; } if ($f === undefined) { $f = { $blk: $b }; } $f._entry = _entry; $f._entry$1 = _entry$1; $f._entry$2 = _entry$2; $f._i = _i; $f._i$1 = _i$1; $f._keys = _keys; $f._keys$1 = _keys$1; $f._ref = _ref; $f._ref$1 = _ref$1; $f.innerKey = innerKey; $f.outerKey = outerKey; $f.q = q; $f.$s = $s; $f.$r = $r; return $f;
		}; })(t)); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: Tally.ptr.prototype.knownChoices }; } $f.$24r = $24r; $f._r = _r; $f.t = t; $f.$s = $s; $f.$r = $r; return $f;
	};
	Tally.prototype.knownChoices = function() { return this.$val.knownChoices(); };
	Tally.ptr.prototype.Matrix = function() {
		var _i, _i$1, _r, _ref, _ref$1, headings, row, rowsColumns, t, xChoice, yChoice, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _i = $f._i; _i$1 = $f._i$1; _r = $f._r; _ref = $f._ref; _ref$1 = $f._ref$1; headings = $f.headings; row = $f.row; rowsColumns = $f.rowsColumns; t = $f.t; xChoice = $f.xChoice; yChoice = $f.yChoice; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		t = this;
		_r = t.knownChoices(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		headings = _r;
		rowsColumns = sliceType$7.nil;
		_ref = headings;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			yChoice = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			row = sliceType$4.nil;
			_ref$1 = headings;
			_i$1 = 0;
			while (true) {
				if (!(_i$1 < _ref$1.$length)) { break; }
				xChoice = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
				if (yChoice === xChoice) {
					row = $append(row, ptrType$9.nil);
				} else {
					row = $append(row, t.GetPair(yChoice, xChoice));
				}
				_i$1++;
			}
			rowsColumns = $append(rowsColumns, row);
			_i++;
		}
		$s = -1; return new TallyMatrix.ptr(headings, rowsColumns, ptrType$7.nil);
		/* */ } return; } if ($f === undefined) { $f = { $blk: Tally.ptr.prototype.Matrix }; } $f._i = _i; $f._i$1 = _i$1; $f._r = _r; $f._ref = _ref; $f._ref$1 = _ref$1; $f.headings = headings; $f.row = row; $f.rowsColumns = rowsColumns; $f.t = t; $f.xChoice = xChoice; $f.yChoice = yChoice; $f.$s = $s; $f.$r = $r; return $f;
	};
	Tally.prototype.Matrix = function() { return this.$val.Matrix(); };
	NewElection = function(electionID, ballots) {
		var _r, ballots, choices, electionID, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _r = $f._r; ballots = $f.ballots; choices = $f.choices; electionID = $f.electionID; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		ballots = [ballots];
		_r = internal.SortedUniques((function(ballots) { return function $b(q) {
			var _i, _i$1, _i$2, _ref, _ref$1, _ref$2, ballot, choice, priorityChoices, q, $s, $r;
			/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; _i = $f._i; _i$1 = $f._i$1; _i$2 = $f._i$2; _ref = $f._ref; _ref$1 = $f._ref$1; _ref$2 = $f._ref$2; ballot = $f.ballot; choice = $f.choice; priorityChoices = $f.priorityChoices; q = $f.q; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
			_ref = ballots[0];
			_i = 0;
			/* while (true) { */ case 1:
				/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 2; continue; }
				ballot = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
				_ref$1 = ballot.Priorities;
				_i$1 = 0;
				/* while (true) { */ case 3:
					/* if (!(_i$1 < _ref$1.$length)) { break; } */ if(!(_i$1 < _ref$1.$length)) { $s = 4; continue; }
					priorityChoices = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
					_ref$2 = priorityChoices;
					_i$2 = 0;
					/* while (true) { */ case 5:
						/* if (!(_i$2 < _ref$2.$length)) { break; } */ if(!(_i$2 < _ref$2.$length)) { $s = 6; continue; }
						choice = ((_i$2 < 0 || _i$2 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$2]);
						$r = $send(q, choice); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
						_i$2++;
					$s = 5; continue;
					case 6:
					_i$1++;
				$s = 3; continue;
				case 4:
				_i++;
			$s = 1; continue;
			case 2:
			$s = -1; return;
			/* */ } return; } if ($f === undefined) { $f = { $blk: $b }; } $f._i = _i; $f._i$1 = _i$1; $f._i$2 = _i$2; $f._ref = _ref; $f._ref$1 = _ref$1; $f._ref$2 = _ref$2; $f.ballot = ballot; $f.choice = choice; $f.priorityChoices = priorityChoices; $f.q = q; $f.$s = $s; $f.$r = $r; return $f;
		}; })(ballots)); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		choices = _r;
		$s = -1; return new Election.ptr(electionID, ballots[0], choices);
		/* */ } return; } if ($f === undefined) { $f = { $blk: NewElection }; } $f._r = _r; $f.ballots = ballots; $f.choices = choices; $f.electionID = electionID; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.NewElection = NewElection;
	orderStrings = function(first, second) {
		var first, second;
		if (first < second) {
			return [first, second];
		}
		return [second, first];
	};
	ptrType$4.methods = [{prop: "IDs", name: "IDs", pkg: "", typ: $funcType([], [sliceType], false)}];
	ptrType$12.methods = [{prop: "HasEdgeFromTo", name: "HasEdgeFromTo", pkg: "", typ: $funcType([$String, $String], [$Bool], false)}, {prop: "AddEdge", name: "AddEdge", pkg: "", typ: $funcType([$String, $String], [$error], false)}, {prop: "TSort", name: "TSort", pkg: "", typ: $funcType([], [ptrType$4], false)}, {prop: "kahn", name: "kahn", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([], [ptrType$4, $error], false)}, {prop: "getOrCreateVertex", name: "getOrCreateVertex", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([$String], [ptrType$3], false)}, {prop: "makeEdge", name: "makeEdge", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([ptrType$3, ptrType$3], [ptrType$2], false)}];
	ptrType$13.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$5.methods = [{prop: "Runoffs", name: "Runoffs", pkg: "", typ: $funcType([], [sliceType$4], false)}];
	ptrType$6.methods = [{prop: "Results", name: "Results", pkg: "", typ: $funcType([], [ptrType$15], false)}, {prop: "TallyBallots", name: "TallyBallots", pkg: "", typ: $funcType([], [ptrType$7], false)}];
	ptrType$15.methods = [{prop: "Winners", name: "Winners", pkg: "", typ: $funcType([], [sliceType$3], false)}];
	ptrType$9.methods = [{prop: "VictoryMagnitude", name: "VictoryMagnitude", pkg: "", typ: $funcType([], [$Int64], false)}];
	ptrType$7.methods = [{prop: "RankedPairs", name: "RankedPairs", pkg: "", typ: $funcType([], [ptrType$8], false)}, {prop: "lockedPairs", name: "lockedPairs", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([], [ptrType$10], false)}, {prop: "GetPair", name: "GetPair", pkg: "", typ: $funcType([$String, $String], [ptrType$9], false)}, {prop: "incrementWinner", name: "incrementWinner", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([$String, $String], [], false)}, {prop: "incrementTies", name: "incrementTies", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([$String, $String], [], false)}, {prop: "knownChoices", name: "knownChoices", pkg: "github.com/jicksta/ranked-pairs-voting", typ: $funcType([], [sliceType], false)}, {prop: "Matrix", name: "Matrix", pkg: "", typ: $funcType([], [ptrType$16], false)}];
	Vertex.init("github.com/jicksta/ranked-pairs-voting", [{prop: "ID", name: "ID", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "degreeIn", name: "degreeIn", embedded: false, exported: false, typ: $Int, tag: ""}]);
	Edge.init("", [{prop: "From", name: "From", embedded: false, exported: true, typ: ptrType$3, tag: ""}, {prop: "To", name: "To", embedded: false, exported: true, typ: ptrType$3, tag: ""}]);
	SortedVertices.init(ptrType$3);
	vertexMap.init($String, ptrType$3);
	edgeMap.init($String, mapType$2);
	DAG.init("", [{prop: "Vertices", name: "Vertices", embedded: false, exported: true, typ: ptrType, tag: ""}, {prop: "Edges", name: "Edges", embedded: false, exported: true, typ: ptrType$1, tag: ""}]);
	DAGCycleError.init("", []);
	Ballot.init("", [{prop: "VoterID", name: "VoterID", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Priorities", name: "Priorities", embedded: false, exported: true, typ: sliceType$3, tag: ""}]);
	Election.init("", [{prop: "ElectionID", name: "ElectionID", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Ballots", name: "Ballots", embedded: false, exported: true, typ: sliceType$2, tag: ""}, {prop: "Choices", name: "Choices", embedded: false, exported: true, typ: sliceType, tag: ""}]);
	ElectionResults.init("", [{prop: "Election", name: "Election", embedded: false, exported: true, typ: ptrType$6, tag: ""}, {prop: "Tally", name: "Tally", embedded: false, exported: true, typ: ptrType$7, tag: ""}, {prop: "RankedPairs", name: "RankedPairs", embedded: false, exported: true, typ: ptrType$8, tag: ""}]);
	RankablePair.init("", [{prop: "A", name: "A", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "B", name: "B", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "FavorA", name: "FavorA", embedded: false, exported: true, typ: $Int64, tag: ""}, {prop: "FavorB", name: "FavorB", embedded: false, exported: true, typ: $Int64, tag: ""}, {prop: "Ties", name: "Ties", embedded: false, exported: true, typ: $Int64, tag: ""}]);
	RankedPairs.init("", [{prop: "Winners", name: "Winners", embedded: false, exported: true, typ: sliceType$3, tag: ""}, {prop: "LockedPairs", name: "LockedPairs", embedded: false, exported: true, typ: ptrType$10, tag: ""}, {prop: "CyclicalLockedPairsIndices", name: "CyclicalLockedPairsIndices", embedded: false, exported: true, typ: sliceType$5, tag: ""}]);
	Tally.init("github.com/jicksta/ranked-pairs-voting", [{prop: "pairs", name: "pairs", embedded: false, exported: false, typ: ptrType$11, tag: ""}]);
	TallyMatrix.init("", [{prop: "Headings", name: "Headings", embedded: false, exported: true, typ: sliceType, tag: ""}, {prop: "RowsColumns", name: "RowsColumns", embedded: false, exported: true, typ: sliceType$7, tag: ""}, {prop: "Tally", name: "Tally", embedded: false, exported: true, typ: ptrType$7, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = internal.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = sort.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["main"] = (function() {
	var $pkg = {}, $init, js, trp, Votes, Winners, funcType, ptrType, sliceType, sliceType$1, sliceType$2, main, TRP;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	trp = $packages["github.com/jicksta/ranked-pairs-voting"];
	Votes = $pkg.Votes = $newType(4, $kindMap, "main.Votes", true, "main", true, null);
	Winners = $pkg.Winners = $newType(12, $kindSlice, "main.Winners", true, "main", true, null);
	funcType = $funcType([Votes], [Winners], false);
	ptrType = $ptrType(trp.Ballot);
	sliceType = $sliceType(ptrType);
	sliceType$1 = $sliceType($String);
	sliceType$2 = $sliceType(sliceType$1);
	main = function() {
		$global.TRP = $externalize(TRP, funcType);
	};
	TRP = function(votes) {
		var $24r, _entry, _i, _keys, _r, _r$1, _r$2, _ref, ballots, election, priorities, voterID, votes, $s, $r;
		/* */ $s = 0; var $f, $c = false; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $24r = $f.$24r; _entry = $f._entry; _i = $f._i; _keys = $f._keys; _r = $f._r; _r$1 = $f._r$1; _r$2 = $f._r$2; _ref = $f._ref; ballots = $f.ballots; election = $f.election; priorities = $f.priorities; voterID = $f.voterID; votes = $f.votes; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		ballots = $makeSlice(sliceType, 0, $keys(votes).length);
		_ref = votes;
		_i = 0;
		_keys = $keys(_ref);
		while (true) {
			if (!(_i < _keys.length)) { break; }
			_entry = _ref[_keys[_i]];
			if (_entry === undefined) {
				_i++;
				continue;
			}
			voterID = _entry.k;
			priorities = _entry.v;
			ballots = $append(ballots, new trp.Ballot.ptr(voterID, priorities));
			_i++;
		}
		_r = trp.NewElection("Election", ballots); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		election = _r;
		_r$1 = election.Results(); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = _r$1.Winners(); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = $convertSliceType(_r$2, Winners);
		$s = 4; case 4: return $24r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: TRP }; } $f.$24r = $24r; $f._entry = _entry; $f._i = _i; $f._keys = _keys; $f._r = _r; $f._r$1 = _r$1; $f._r$2 = _r$2; $f._ref = _ref; $f.ballots = ballots; $f.election = election; $f.priorities = priorities; $f.voterID = voterID; $f.votes = votes; $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.TRP = TRP;
	Votes.init($String, sliceType$2);
	Winners.init(sliceType$1);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = trp.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		if ($pkg === $mainPkg) {
			main();
			$mainFinished = true;
		}
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$synthesizeMethods();
$initAllLinknames();
var $mainPkg = $packages["main"];
$packages["runtime"].$init();
$go($mainPkg.$init, []);
$flushConsole();

}).call(this);
//# sourceMappingURL=exporter.js.map
