/* jshint node: true */ 
'use strict';

var utils = require('./utils'),
    util = require('util');

var f = util.format;

/**
 * Deserialize a value from its JSON encoding.
 *
 * This method is the inverse of `toJSON`.
 *
 * Options:
 *
 * + `allowUndeclaredFields`, to skip record fields which are not declared in
 *   the schema.
 */
function fromJSON(any, type, opts) {
  return clone('FROM_JSON', any, type, opts);
}

/**
 * Deserialize a value from its encoding as a default.
 *
 * This method is mostly useful internally, to decode record schemas (which
 * include fields with defaults serialized using this encoding).
 *
 * Options:
 *
 * + `allowUndeclaredFields`, to skip record fields which are not declared in
 *   the schema.
 */
function fromDefaultJSON(any, type, opts) {
  return clone('FROM_DEFAULT_JSON', any, type, opts);
}

/**
 * JSON-serialize a value.
 *
 * This method is the inverse of `fromJSON`.
 *
 * Options:
 *
 * + `omitDefaultValues`, to omit values equal to their default in the returned
 *   JSON.
 */
function toJSON(any, type, opts) {
  return clone('TO_JSON', any, type, opts);
}

// Internal functions below.

function clone(mode, any, type, opts) {
  return new Cloner(mode, opts).clone(any, type, []).build(type);
}

/** Value builder. */
function Builder() {
  this.value = undefined;
  this.errors = [];
}

Builder.prototype.isOk = function () { return !this.errors.length; };

Builder.prototype.build = function (type) {
  if (!this.errors.length) {
    return this.value;
  }
  var details = [];
  var i, l;
  for (i = 0, l = this.errors.length; i < l; i++) {
    details.push(f('\t%s', this.errors[i].message));
  }
  var msg = f(
    '%s error(s) when expecting %s:\n%s',
    this.errors.length, typeInfo(type), details.join('\n')
  );
  var err = new Error(msg);
  err.code = 'ERR_AVRO_INCOMPATIBLE_VALUE';
  err.type = type;
  err.errors = this.errors;
  throw err;
};

Builder.prototype.addError = function (desc, val, type, path) {
  var info = typeInfo(type);
  var msg = f('$%s has %s but %s: %j', joinPath(path), info, desc, val);
  var err = new Error(msg);
  err.value = val;
  err.expectedType = type;
  err.path = path;
  this.errors.push(err);
};

Builder.prototype.copyErrorsFrom = function (builder) {
  if (builder.errors.length) {
    this.errors = this.errors.concat(builder.errors);
  }
};

function typeInfo(type) {
  if (utils.isType(type, 'union')) {
    var names = type.types.map(function (type) { return type.branchName; });
    return f('a type among %s', names.join(', '));
  } else if (utils.isType(type, 'logical')) {
    return f('type %s (%s)', type.typeName, type.branchName);
  } else {
    return f('type %s', type.branchName);
  }
}

function Cloner(mode, opts) {
  opts = opts || {};
  this._mode = mode; // TO_JSON, FROM_JSON, FROM_DEFAULT_JSON.
  this._allowUndeclaredFields = !!opts.allowUndeclaredFields;
  this._omitDefaultValues = !!opts.omitDefaultValues;
  if (this._omitDefaultValues && this._mode !== 'TO_JSON') {
    throw new Error('invalid cloner options');
  }
}

Cloner.prototype.clone = function (any, type, path) {
  if (!utils.isType(type)) {
    throw new Error(f('not a type: %s', type));
  }
  switch (type.typeName) {
    case 'array':
      return this._onArray(any, type, path);
    case 'map':
      return this._onMap(any, type, path);
    case 'error':
    case 'record':
      return this._onRecord(any, type, path);
    case 'union:unwrapped':
    case 'union:wrapped':
      return this._onUnion(any, type, path);
    default:
      return utils.isType(type, 'logical') ?
        this._onLogical(any, type, path) :
        this._onPrimitive(any, type, path);
  }
};

Cloner.prototype._onLogical = function (any, type, path) {
  var builder = new Builder();
  var desc;
  if (this._mode === 'TO_JSON') {
    try {
      builder.value = type._toValue(any);
      if (builder.value === undefined) {
        builder.addError('logical type encoding failed', any, type, path);
        return builder;
      }
    } catch (err) {
      desc = f('logical type encoding failed (%s)', err.message);
      builder.addError(desc, any, type, path);
      return builder;
    }
  } else {
    builder.value = any;
  }
  builder = this.clone(builder.value, type.underlyingType, path);
  if (!builder.isOk()) {
    return builder;
  }
  if (this._mode !== 'TO_JSON') {
    try {
      builder.value = type._fromValue(builder.value);
    } catch (err) {
      desc = f('logical type decoding failed (%s)', err.message);
      builder.addError(desc, any, type, path);
    }
  }
  return builder;
};

Cloner.prototype._onPrimitive = function (any, type, path) {
  var builder = new Builder();
  var isBufferType = utils.isType(type, 'bytes', 'fixed');
  var val = any;
  if (isBufferType && this._mode !== 'TO_JSON') {
    if (typeof any != 'string') {
      builder.addError('is not a string', any, type, path);
      return builder;
    }
    val = utils.bufferFrom(any, 'binary');
  }
  if (type.isValid(val)) {
    builder.value = isBufferType ? utils.bufferFrom(val) : val;
  } else {
    builder.addError('invalid value', any, type, path);
  }
  if (this._mode === 'TO_JSON' && isBufferType) {
    builder.value = builder.value.toString('binary');
  }
  return builder;
};

Cloner.prototype._onRecord = function (any, type, path) {
  var builder = new Builder();
  var desc;
  if (!any || typeof any != 'object') {
    builder.addError('is not a valid object', any, type, path);
    return builder;
  }
  var i, l;
  if (!this._allowUndeclaredFields) {
    var extraFields = [];
    var fieldNames = Object.keys(any);
    var fieldName;
    for (i = 0, l = fieldNames.length; i < l; i++) {
      fieldName = fieldNames[i];
      if (!type.field(fieldName)) {
        extraFields.push(fieldName);
      }
    }
    if (extraFields.length) {
      desc = f(
        'contains %s undeclared field(s) (%s)',
        extraFields.length, extraFields.join(', ')
      );
      builder.addError(desc, any, type, path);
    }
  }
  var missingFields = [];
  var args = [undefined];
  var field, fieldAny, fieldVal, fieldPath, fieldValBuilder, defaultVal;
  for (i = 0, l = type.fields.length; i < l; i++) {
    field = type.fields[i];
    fieldAny = any[field.name];
    fieldPath = path.slice();
    fieldPath.push(field.name);
    defaultVal = field.defaultValue();
    fieldVal = undefined;
    if (fieldAny === undefined && defaultVal === undefined) {
      missingFields.push(field.name);
    } else if (fieldAny === undefined) {
      if (this._mode === 'TO_JSON' && !this._omitDefaultValues) {
        fieldVal = this.clone(defaultVal, field.type, fieldPath).value;
      }
    } else {
      fieldValBuilder = this.clone(fieldAny, field.type, fieldPath);
      builder.copyErrorsFrom(fieldValBuilder);
      fieldVal = fieldValBuilder.value;
      if (
        this._omitDefaultValues &&
        fieldValBuilder.isOk() &&
        defaultVal !== undefined &&
        !field.type.compare(fieldAny, defaultVal, {allowMaps: true})
      ) {
        fieldVal = undefined;
      }
    }
    args.push(fieldVal);
  }
  if (missingFields.length) {
    desc = f(
      'is missing %s field(s) (%s)',
      missingFields.length,
      missingFields.join()
    );
    builder.addError(desc, any, type, path);
  }
  if (builder.isOk()) {
    if (this._mode === 'TO_JSON') {
      builder.value = {};
      for (i = 0, l = type.fields.length; i < l; i++) {
        fieldVal = args[i + 1];
        if (fieldVal !== undefined) {
          builder.value[type.fields[i].name] = fieldVal;
        }
      }
    } else {
      var Record = type.recordConstructor;
      builder.value = new (Record.bind.apply(Record, args))();
    }
  }
  return builder;
};

Cloner.prototype._onArray = function (any, type, path) {
  var builder = new Builder();
  if (!Array.isArray(any)) {
    builder.addError('is not an array', any, type, path);
    return builder;
  }
  var val = [];
  var i, l, item;
  for (i = 0, l = any.length; i < l; i++) {
    item = any[i];
    var itemPath = path.slice();
    itemPath.push(i);
    var itemBuilder = this.clone(item, type.itemsType, itemPath);
    builder.copyErrorsFrom(itemBuilder);
    if (builder.isOk()) {
      val.push(itemBuilder.value);
    }
  }
  if (builder.isOk()) {
    builder.value = val;
  }
  return builder;
};

Cloner.prototype._onMap = function (any, type, path) {
  var builder = new Builder();
  if (!any || typeof any != 'object') {
    builder.addError('is not a valid object', any, type, path);
    return builder;
  }
  var val = {};
  var keys = Object.keys(any).sort();
  var i, l;
  for (i = 0, l = keys.length; i < l; i++) {
    var key = keys[i];
    var anyValue = any[key];
    var valuePath = path.slice();
    valuePath.push(key);
    var valueBuilder = this.clone(anyValue, type.valuesType, valuePath);
    builder.copyErrorsFrom(valueBuilder);
    if (builder.isOk()) {
      val[key] = valueBuilder.value;
    }
  }
  if (builder.isOk()) {
    builder.value = val;
  }
  return builder;
};

Cloner.prototype._onUnion = function (any, unionType, path) {
  var isWrapped = unionType.typeName === 'union:wrapped';
  var builder = new Builder();
  if (any === null) {
    var i, l;
    for (i = 0, l = unionType.types.length; i < l; i++) {
      if (unionType.types[i].typeName === 'null') {
        builder.value = null;
        return builder;
      }
    }
    builder.addError('is null', any, unionType, path);
    return builder;
  }
  var branchType;
  if (this._mode === 'FROM_DEFAULT_JSON') {
    branchType = unionType.types[0];
    if (branchType.typeName === 'null') {
      builder.addError('does not match first (null)', any, unionType, path);
      return builder;
    }
    any = branchType.wrap(any);
  } else if (this._mode === 'TO_JSON' && !isWrapped) {
    branchType = unionType.branchType(any);
    if (!branchType) {
      builder.addError('is not a valid branch', any, unionType, path);
      return builder;
    }
    any = branchType.wrap(any);
  }
  if (typeof any != 'object') { // Null will (correctly) be ignored here.
    builder.addError('is not an object', any, unionType, path);
    return builder;
  }
  var keys = Object.keys(any);
  var reason;
  if (keys.length !== 1) {
    reason = f('has %s keys (%s)', keys.length, keys);
    builder.addError(reason, any, unionType, path);
    return builder;
  }
  var key = keys[0];
  branchType = unionType.type(key);
  if (!branchType) {
    reason = f('contains an unknown branch (%s)', key);
    builder.addError(reason, any, unionType, path);
    return builder;
  }
  var branchPath = path.slice();
  branchPath.push(key);
  var branchBuilder = this.clone(any[key], branchType, branchPath);
  builder.copyErrorsFrom(branchBuilder);
  if (branchBuilder.isOk()) {
    if (this._mode === 'TO_JSON') {
      builder.value = {};
      builder.value[branchType.branchName] = branchBuilder.value;
    } else if (!isWrapped) {
      builder.value = branchBuilder.value;
    } else {
      builder.value = branchType.wrap(branchBuilder.value);
    }
  }
  return builder;
};

function joinPath(parts) {
  var strs = [];
  var i, l, part;
  for (i = 0, l = parts.length; i < l; i++) {
    part = parts[i];
    if (isNaN(part)) {
      // TODO: Improve handling for non-identifier keys (e.g. `"this-key"`).
      strs.push('.' + part);
    } else {
      strs.push('[' + part + ']');
    }
  }
  return strs.join('');
}

module.exports = {
  fromJSON: fromJSON,
  fromDefaultJSON: fromDefaultJSON,
  toJSON: toJSON
};
