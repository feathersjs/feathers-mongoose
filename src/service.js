import omit from 'lodash.omit';
import Proto from 'uberproto';
import filter from 'feathers-query-filters';
import errors from 'feathers-errors';
import errorHandler from './error-handler';

// Create the service.
class Service {
  constructor(options) {
    if (!options) {
      throw new Error('Mongoose options have to be provided');
    }

    if (!options.Model || !options.Model.modelName) {
      throw new Error('You must provide a Mongoose Model');
    }

    // this.name = options.name;
    this.Model = options.Model;
    this.id = options.id || '_id';
    this.paginate = options.paginate || {};
    this.lean = options.lean || false;
    this.overwrite = (options.overwrite === false) ? false : true;
  }

  extend(obj) {
    return Proto.extend(obj, this);
  }

  _find(params, count, getFilter = filter) {
    const { filters, query } = getFilter(params.query || {});
    const q = this.Model.find(query).lean(this.lean);

    // $select uses a specific find syntax, so it has to come first.
    if (filters.$select && filters.$select.length) {
      let fields = {};

      for (let key of filters.$select) {
        fields[key] = 1;
      }

      q.select(fields);
    } else {
      if(filters.$select && typeof filters.$select === 'object') {
        q.select(filters.$select);
      }
    }

    // Handle $sort
    if (filters.$sort) {
      q.sort(filters.$sort);
    }

    // Handle $limit
    if (filters.$limit) {
      q.limit(filters.$limit);
    }

    // Handle $skip
    if (filters.$skip) {
      q.skip(filters.$skip);
    }

    // Handle $populate
    if (filters.$populate){
      q.populate(filters.$populate);
    }

    const executeQuery = total => {
      return q.exec().then(data => {
        return {
          total,
          limit: filters.$limit,
          skip: filters.$skip || 0,
          data
        };
      });
    };

    if(count) {
      return this.Model.where(query).count().exec().then(executeQuery);
    }

    return executeQuery();
  }

  find(params) {
    const paginate = (params && typeof params.paginate !== 'undefined') ?
      params.paginate : this.paginate;
    const result = this._find(params, !!paginate.default,
      query => filter(query, paginate)
    );

    if(!paginate.default) {
      return result.then(page => page.data);
    }

    return result;
  }

  _get(id, params = {}) {
    params.query = params.query || {};

    let modelQuery = this
      .Model
      .findOne({ [this.id]: id });

    if (params.query.$populate) {
      modelQuery = modelQuery.populate(params.query.$populate);
    }

    return modelQuery
      .lean(this.lean)
      .exec()
      .then(data => {
        if(!data) {
          throw new errors.NotFound(`No record found for id '${id}'`);
        }

        return data;
      })
      .catch(errorHandler);
  }

  get(id, params) {
    return this._get(id, params);
  }

  _getOrFind(id, params) {
    if(id === null) {
      return this._find(params).then(page => page.data);
    }

    return this._get(id, params);
  }

  create(data) {
    return this.Model.create(data).catch(errorHandler);
  }

  update(id, data, params) {
    if (id === null) {
      return Promise.reject('Not replacing multiple records. Did you mean `patch`?');
    }

    // Handle case where data might be a mongoose model
    if (typeof data.toObject === 'function') {
      data = data.toObject();
    }

    const options = Object.assign({
      new: true,
      overwrite: this.overwrite,
      runValidators: true,
      context: 'query',
      setDefaultsOnInsert: true
    }, params.mongoose);

    if (this.id === '_id') {
      // We can not update default mongo ids
      data = omit(data, this.id);
    } else {
      // If not using the default Mongo _id field set the id to its
      // previous value. This prevents orphaned documents.
      data = Object.assign({}, data, { [this.id]: id });
    }

    let modelQuery = this.Model.findOneAndUpdate({ [this.id]: id }, data, options);

    if (params && params.query && params.query.$populate) {
      modelQuery = modelQuery.populate(params.query.$populate);
    }

    return modelQuery
      .lean(this.lean)
      .exec()
      .catch(errorHandler);
  }

  patch(id, data, params) {
    params.query = params.query || {};

    // Handle case where data might be a mongoose model
    if (typeof data.toObject === 'function') {
      data = data.toObject();
    }

    // ensure we are working on a copy
    data = Object.assign({}, data);

    // If we are updating multiple records
    let options = Object.assign({
      multi: id === null,
      runValidators: true,
      context: 'query'
    }, params.mongoose);

    if (id !== null) {
      params.query[this.id] = id;
    }

    if (this.id === '_id') {
      // We can not update default mongo ids
      delete data[this.id];
    } else {
      // If not using the default Mongo _id field set the id to its
      // previous value. This prevents orphaned documents.
      data[this.id] = id;
    }

    // We need this shitty hack because update doesn't return
    // a promise properly when runValidators is true. WTF!
    try {
      // If params.query.$populate was provided, remove it
      // from the query sent to mongoose.
      const query = omit(params.query, '$populate');

      return this.Model
        .update(query, data, options)
        .lean(this.lean)
        .exec()
        .then(() => this._getOrFind(id, params))
        .catch(errorHandler);
    }
    catch(e) {
      return errorHandler(e);
    }
  }

  remove(id, params) {
    const query = Object.assign({}, params.query);

    if (id !== null) {
      query[this.id] = id;
    }

    // NOTE (EK): First fetch the record(s) so that we can return
    // it/them when we delete it/them.
    return this._getOrFind(id, params)
      .then(data => this.Model
        .remove(query)
        .lean(this.lean)
        .exec()
        .then(() => data)
        .catch(errorHandler)
      )
      .catch(errorHandler);
  }
}

export default function init(options) {
  return new Service(options);
}

init.Service = Service;
