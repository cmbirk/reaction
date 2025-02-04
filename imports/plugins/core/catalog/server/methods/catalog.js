import _ from "lodash";
import Logger from "@reactioncommerce/logger";
import Random from "@reactioncommerce/random";
import { check, Match } from "meteor/check";
import { EJSON } from "meteor/ejson";
import { Meteor } from "meteor/meteor";
import { ReactionProduct } from "/lib/api";
import Reaction from "/imports/plugins/core/core/server/Reaction";
import ReactionError from "@reactioncommerce/reaction-error";
import { MediaRecords, Products, Tags } from "/lib/collections";
import appEvents from "/imports/node-app/core/util/appEvents";
import rawCollections from "/imports/collections/rawCollections";
import getGraphQLContextInMeteorMethod from "/imports/plugins/core/graphql/server/getGraphQLContextInMeteorMethod";
import hashProduct from "../no-meteor/mutations/hashProduct";

/* eslint new-cap: 0 */
/* eslint no-loop-func: 0 */
/* eslint quotes: 0 */

/**
 * @file Methods for Products. Run these methods using `Meteor.call()`.
 *
 *
 * @namespace Methods/Products
 */

/**
 * @function createTitle
 * @private
 * @description Recursive method which trying to find a new `title`, given the
 * existing copies
 * @param {String} newTitle - product `title`
 * @param {String} productId - current product `_id`
 * @return {String} title - modified `title`
 */
function createTitle(newTitle, productId) {
  // exception product._id needed for cases then double triggering happens
  let title = newTitle || "";
  const titleCount = Products.find({
    title,
    _id: {
      $nin: [productId]
    }
  }).count();
  // current product "copy" number
  let titleNumberSuffix = 0;
  // product handle prefix
  let titleString = title;
  // copySuffix "-copy-number" suffix of product
  const copySuffix = titleString.match(/-copy-\d+$/) || titleString.match(/-copy$/);
  // if product is a duplicate, we should take the copy number, and cut
  // the handle
  if (copySuffix) {
    // we can have two cases here: copy-number and just -copy. If there is
    // no numbers in copySuffix then we should put 1 in handleNumberSuffix
    titleNumberSuffix = +String(copySuffix).match(/\d+$/) || 1;
    // removing last numbers and last "-" if it presents
    titleString = title.replace(/\d+$/, "").replace(/-$/, "");
  }

  // if we have more than one product with the same handle, we should mark
  // it as "copy" or increment our product handle if it contain numbers.
  if (titleCount > 0) {
    // if we have product with name like "product4", we should take care
    // about its uniqueness
    if (titleNumberSuffix > 0) {
      title = `${titleString}-${titleNumberSuffix + titleCount}`;
    } else {
      // first copy will be "...-copy", second: "...-copy-2"
      title = `${titleString}-copy${titleCount > 1 ? `-${titleCount}` : ""}`;
    }
  }

  // we should check again if there are any new matches with DB
  if (
    Products.find({
      title
    }).count() !== 0
  ) {
    title = createTitle(title, productId);
  }
  return title;
}

/**
 * @function createHandle
 * @private
 * @description Recursive method which trying to find a new `handle`, given the
 * existing copies
 * @param {String} productHandle - product `handle`
 * @param {String} productId - current product `_id`
 * @return {String} handle - modified `handle`
 */
function createHandle(productHandle, productId) {
  let handle = productHandle || "";
  // exception product._id needed for cases then double triggering happens
  const handleCount = Products.find({
    handle,
    _id: {
      $nin: [productId]
    }
  }).count();
  // current product "copy" number
  let handleNumberSuffix = 0;
  // product handle prefix
  let handleString = handle;
  // copySuffix "-copy-number" suffix of product
  const copySuffix = handleString.match(/-copy-\d+$/) || handleString.match(/-copy$/);

  // if product is a duplicate, we should take the copy number, and cut
  // the handle
  if (copySuffix) {
    // we can have two cases here: copy-number and just -copy. If there is
    // no numbers in copySuffix then we should put 1 in handleNumberSuffix
    handleNumberSuffix = +String(copySuffix).match(/\d+$/) || 1;
    // removing last numbers and last "-" if it presents
    handleString = handle.replace(/\d+$/, "").replace(/-$/, "");
  }

  // if we have more than one product with the same handle, we should mark
  // it as "copy" or increment our product handle if it contain numbers.
  if (handleCount > 0) {
    // if we have product with name like "product4", we should take care
    // about its uniqueness
    if (handleNumberSuffix > 0) {
      handle = `${handleString}-${handleNumberSuffix + handleCount}`;
    } else {
      // first copy will be "...-copy", second: "...-copy-2"
      handle = `${handleString}-copy${handleCount > 1 ? `-${handleCount}` : ""}`;
    }
  }

  // we should check again if there are any new matches with DB
  // exception product._id needed for cases then double triggering happens
  const newHandleCount = Products.find({
    handle,
    _id: {
      $nin: [productId]
    }
  }).count();

  if (newHandleCount !== 0) {
    handle = createHandle(handle, productId);
  }

  return handle;
}

/**
 * @function copyMedia
 * @private
 * @description copy images links to cloned variant from original
 * @param {String} newId - [cloned|original] product _id
 * @param {String} variantOldId - old variant _id
 * @param {String} variantNewId - - cloned variant _id
 * @return {undefined}
 */
function copyMedia(newId, variantOldId, variantNewId) {
  rawCollections.Media.find({
    "metadata.variantId": variantOldId
  })
    .then((fileRecords) => {
      // Copy File and insert
      const promises = fileRecords.map((fileRecord) =>
        fileRecord.fullClone({
          productId: newId,
          variantId: variantNewId
        }));
      return Promise.all(promises);
    })
    .catch((error) => {
      Logger.error(`Error in copyMedia for product ${newId}`, error);
    });
}

/**
 * @function createProduct
 * @private
 * @description creates a product
 * @param {Object} props - initial product properties
 * @param {Object} info - Other info
 * @return {Object} product - new product
 */
function createProduct(props = null, info = {}) {
  const newProductOrVariant = {
    shopId: Reaction.getShopId(),
    type: "simple",
    ...(props || {})
  };

  const userId = Reaction.getUserId();
  const context = Promise.await(getGraphQLContextInMeteorMethod(userId));

  if (newProductOrVariant.type === "variant") {
    // Apply custom transformations from plugins.
    for (const customFunc of context.getFunctionsOfType("mutateNewVariantBeforeCreate")) {
      // Functions of type "mutateNewVariantBeforeCreate" are expected to mutate the provided variant.
      Promise.await(customFunc(newProductOrVariant, { context, ...info }));
    }
  } else {
    // Set handle for products only, not variants
    if (!newProductOrVariant.handle) {
      if (typeof newProductOrVariant.title === "string" && newProductOrVariant.title.length) {
        newProductOrVariant.handle = Reaction.getSlug(newProductOrVariant.title);
      }
    }

    // Apply custom transformations from plugins.
    for (const customFunc of context.getFunctionsOfType("mutateNewProductBeforeCreate")) {
      // Functions of type "mutateNewProductBeforeCreate" are expected to mutate the provided variant.
      Promise.await(customFunc(newProductOrVariant, { context, ...info }));
    }
  }

  const _id = Products.insert(newProductOrVariant);

  return Products.findOne({ _id });
}

/**
 * @function
 * @name updateCatalogProduct
 * @summary Updates a product document.
 * @param {String} userId - currently logged in user
 * @param {Object} selector - selector for product to update
 * @param {Object} modifier - Object describing what parts of the document to update.
 * @param {Object} validation - simple schema validation options
 * @return {String} _id of updated document
 */
function updateCatalogProduct(userId, selector, modifier, validation) {
  const product = Products.findOne(selector);

  const result = Products.update(selector, modifier, validation);

  hashProduct(product._id, rawCollections, false)
    .catch((error) => {
      Logger.error(`Error updating currentProductHash for product with ID ${product._id}`, error);
    });

  return result;
}

Meteor.methods({
  /**
   * @name products/cloneVariant
   * @memberof Methods/Products
   * @method
   * @summary clones a product variant into a new variant
   * @description the method copies variants, but will also create and clone
   * child variants (options)
   * @param {String} productId - the productId we're whose variant we're
   * cloning
   * @param {String} variantId - the variantId that we're cloning
   * @todo rewrite @description
   * @return {Array} - list with cloned variants _ids
   */
  "products/cloneVariant"(productId, variantId) {
    check(productId, String);
    check(variantId, String);

    // Check first if Variant exists and then if user has the right to clone it
    const variant = Products.findOne({ _id: variantId });
    if (!variant) {
      throw new ReactionError("not-found", "Variant not found");
    }

    const authUserId = Reaction.getUserId();

    if (!Reaction.hasPermission("createProduct", authUserId, variant.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    // Verify that this variant and any ancestors are not deleted.
    // Child variants cannot be added if a parent product is marked as `{ isDeleted: true }`
    if (ReactionProduct.isAncestorDeleted(variant, true)) {
      throw new ReactionError("server-error", "Unable to create product variant");
    }

    const variants = Products.find({
      $or: [
        {
          _id: variantId
        },
        {
          ancestors: {
            $in: [variantId]
          },
          isDeleted: false
        }
      ],
      type: "variant"
    }).fetch();

    // exit if we're trying to clone a ghost
    if (variants.length === 0) return [];

    const context = Promise.await(getGraphQLContextInMeteorMethod(authUserId));

    const variantNewId = Random.id(); // for the parent variant
    // we need to make sure that top level variant will be cloned first, his
    // descendants later.
    // we could use this way in future: http://stackoverflow.com/questions/
    // 9040161/mongo-order-by-length-of-array, by now following are allowed
    // @link https://lodash.com/docs#sortBy
    const sortedVariants = _.sortBy(variants, (doc) => doc.ancestors.length);

    return sortedVariants.map((sortedVariant) => {
      const oldId = sortedVariant._id;
      let type = "child";
      const clone = {};
      if (variantId === sortedVariant._id) {
        type = "parent";
        Object.assign(clone, sortedVariant, {
          _id: variantNewId,
          title: `${sortedVariant.title} - copy`,
          optionTitle: `${sortedVariant.optionTitle} - copy`
        });
      } else {
        const parentIndex = sortedVariant.ancestors.indexOf(variantId);
        const ancestorsClone = sortedVariant.ancestors.slice(0);
        // if variantId exists in ancestors, we override it by new _id
        if (parentIndex >= 0) ancestorsClone.splice(parentIndex, 1, variantNewId);
        Object.assign(clone, variant, {
          _id: Random.id(),
          ancestors: ancestorsClone,
          title: `${sortedVariant.title}`,
          optionTitle: `${sortedVariant.optionTitle}`,
          height: `${sortedVariant.height}`,
          width: `${sortedVariant.width}`,
          weight: `${sortedVariant.weight}`,
          length: `${sortedVariant.length}`
        });
      }
      delete clone.updatedAt;
      delete clone.createdAt;

      // Apply custom transformations from plugins.
      for (const customFunc of context.getFunctionsOfType("mutateNewVariantBeforeCreate")) {
        // Functions of type "mutateNewVariantBeforeCreate" are expected to mutate the provided variant.
        Promise.await(customFunc(clone, { context, isOption: clone.ancestors.length > 1 }));
      }

      copyMedia(productId, oldId, clone._id);

      let newId;
      try {
        newId = Products.insert(clone, { validate: false });
        Logger.debug(`products/cloneVariant: created ${type === "child" ? "sub child " : ""}clone: ${clone._id} from ${variantId}`);
      } catch (error) {
        Logger.error(`products/cloneVariant: cloning of ${variantId} was failed: ${error}`);
        throw error;
      }

      return newId;
    });
  },

  /**
   * @name products/createVariant
   * @memberof Methods/Products
   * @method
   * @summary initializes empty variant template
   * @param {String} parentId - the product _id or top level variant _id where
   * we create variant
   * @return {String} new variantId
   */
  "products/createVariant"(parentId) {
    check(parentId, String);

    // Check first if Product exists and then if user has the rights
    const parent = Products.findOne({ _id: parentId });
    if (!parent) {
      throw new ReactionError("not-found", "Parent not found");
    }

    let product;
    let parentVariant;
    if (parent.type === "variant") {
      product = Products.findOne({ _id: parent.ancestors[0] });
      parentVariant = parent;
    } else {
      product = parent;
      parentVariant = null;
    }

    const userId = Reaction.getUserId();
    if (!Reaction.hasPermission("createProduct", userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    // Verify that the parent variant and any ancestors are not deleted.
    // Child variants cannot be added if a parent product is marked as `{ isDeleted: true }`
    if (ReactionProduct.isAncestorDeleted(product, true)) {
      throw new ReactionError("server-error", "Unable to create product variant");
    }

    // get parent ancestors to build new ancestors array
    const { ancestors } = parent;
    Array.isArray(ancestors) && ancestors.push(parentId);

    const newVariantId = Random.id();
    const newVariant = {
      _id: newVariantId,
      ancestors,
      shopId: product.shopId,
      type: "variant"
    };

    const isOption = ancestors.length > 1;

    createProduct(newVariant, { product, parentVariant, isOption });

    Logger.debug(`products/createVariant: created variant: ${newVariantId} for ${parentId}`);

    return newVariantId;
  },

  /**
   * @name products/deleteVariant
   * @memberof Methods/Products
   * @method
   * @summary delete variant, which should also delete child variants
   * @param {String} variantId - variantId to delete
   * @returns {Boolean} returns update results: `true` - if at least one variant
   * was removed or `false` if nothing was removed
   */
  "products/deleteVariant"(variantId) {
    check(variantId, String);

    // Check first if Variant exists and then if user has the right to delete it
    const variant = Products.findOne({ _id: variantId });
    if (!variant) {
      throw new ReactionError("not-found", "Variant not found");
    }

    if (variant.type !== "variant") {
      throw new ReactionError("invalid", "Not a variant");
    }

    const authUserId = Reaction.getUserId();
    if (!Reaction.hasPermission("createProduct", authUserId, variant.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    const variantsToDelete = Products.find({
      // Don't "archive" variants that are already marked deleted.
      isDeleted: {
        $ne: true
      },
      $or: [
        {
          _id: variantId
        },
        {
          ancestors: variantId
        }
      ]
    }).fetch();

    // out if nothing to delete
    if (variantsToDelete.length === 0) return false;

    // Flag the variant and all its children as deleted.
    variantsToDelete.forEach((variantToDelete) => {
      Products.update(
        {
          _id: variantToDelete._id
        },
        {
          $set: {
            isDeleted: true
          }
        }, {
          selector: { type: "variant" }
        }
      );

      appEvents.emit("afterVariantSoftDelete", {
        variant: {
          ...variantToDelete,
          isDeleted: true
        },
        deletedBy: authUserId
      });
    });

    Logger.debug(`Flagged variant and all its children as deleted.`);

    return true;
  },

  /**
   * @name products/cloneProduct
   * @memberof Methods/Products
   * @method
   * @summary clone a whole product, defaulting visibility, etc
   * in the future we are going to do an inheritance product
   * that maintains relationships with the cloned product tree
   * @param {Array} productOrArray - products array to clone
   * @returns {Array} returns insert results
   */
  "products/cloneProduct"(productOrArray) {
    check(productOrArray, Match.OneOf(Array, Object));

    // REVIEW: This check may be unnecessary now - checks that user has permission to clone
    // for active shop
    if (!Reaction.hasPermission("createProduct")) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    if (Array.isArray(productOrArray)) {
      if (productOrArray.length && _.every(productOrArray, (value) => typeof value === "string")) {
        productOrArray = Products.find({ // eslint-disable-line no-param-reassign
          _id: { $in: productOrArray }
        }).fetch();
      }

      // Reduce to unique shops found among products in this array
      const shopIds = productOrArray.map((prod) => prod.shopId);
      const uniqueShopIds = [...new Set(shopIds)];

      // For each unique shopId check to make sure that user has permission to clone
      uniqueShopIds.forEach((shopId) => {
        if (!Reaction.hasPermission("createProduct", this.userId, shopId)) {
          throw new ReactionError("access-denied", "Access Denied");
        }
      });
    } else if (!Reaction.hasPermission("createProduct", this.userId, productOrArray.shopId)) {
      // Single product was passed in - ensure that user has permission to clone
      throw new ReactionError("access-denied", "Access Denied");
    }

    let result;
    let products;
    const results = [];
    const pool = []; // pool of id pairs: { oldId, newId }

    // eslint-disable-next-line require-jsdoc
    function getIds(id) {
      return pool.filter(
        function (pair) {
          return pair.oldId === this.id;
        },
        {
          id
        }
      );
    }

    // eslint-disable-next-line require-jsdoc
    function setId(ids) {
      return pool.push(ids);
    }

    // eslint-disable-next-line require-jsdoc
    function buildAncestors(ancestors) {
      const newAncestors = [];
      ancestors.map((oldId) => {
        const pair = getIds(oldId);
        newAncestors.push(pair[0].newId);
        return newAncestors;
      });
      return newAncestors;
    }

    if (!Array.isArray(productOrArray)) {
      products = [productOrArray];
    } else {
      products = productOrArray;
    }

    for (const product of products) {
      // cloning product
      const productNewId = Random.id();
      setId({
        oldId: product._id,
        newId: productNewId
      });

      const newProduct = Object.assign({}, product, {
        _id: productNewId
        // ancestors: product.ancestors.push(product._id)
      });
      delete newProduct.updatedAt;
      delete newProduct.createdAt;
      delete newProduct.publishedAt;
      delete newProduct.positions;
      delete newProduct.handle;
      newProduct.isVisible = false;
      if (newProduct.title) {
        // todo test this
        newProduct.title = createTitle(newProduct.title, newProduct._id);
        newProduct.handle = createHandle(Reaction.getSlug(newProduct.title), newProduct._id);
      }
      result = Products.insert(newProduct, { validate: false });
      results.push(result);

      // cloning variants
      const variants = Products.find({
        ancestors: {
          $in: [product._id]
        },
        type: "variant"
      }).fetch();
      // why we are using `_.sortBy` described in `products/cloneVariant`
      const sortedVariants = _.sortBy(variants, (doc) => doc.ancestors.length);
      for (const variant of sortedVariants) {
        const variantNewId = Random.id();
        setId({
          oldId: variant._id,
          newId: variantNewId
        });
        const ancestors = buildAncestors(variant.ancestors);
        const newVariant = Object.assign({}, variant, {
          _id: variantNewId,
          ancestors
        });
        delete newVariant.updatedAt;
        delete newVariant.createdAt;

        result = Products.insert(newVariant, { validate: false });
        copyMedia(productNewId, variant._id, variantNewId);
        results.push(result);
      }
    }
    return results;
  },

  /**
   * @name products/createProduct
   * @memberof Methods/Products
   * @method
   * @summary when we create a new product, we create it with an empty variant.
   * @return {String} The new product ID
   */
  "products/createProduct"() {
    // Ensure user has createProduct permission for active shop
    if (!Reaction.hasPermission("createProduct")) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    // Create a product
    const newSimpleProduct = createProduct();

    // Create a product variant
    createProduct({
      ancestors: [newSimpleProduct._id],
      type: "variant" // needed for multi-schema
    }, { product: newSimpleProduct, parentVariant: null, isOption: false });

    return newSimpleProduct._id;
  },

  /**
   * @name products/archiveProduct
   * @memberof Methods/Products
   * @method
   * @summary archive a product and unlink it from all media
   * @param {String} productId - productId to delete
   * @returns {Number} returns number of removed products
   */
  // eslint-disable-next-line consistent-return
  "products/archiveProduct"(productId) {
    check(productId, Match.OneOf(Array, String));

    let extractedProductId;
    if (Array.isArray(productId)) {
      [extractedProductId] = productId;
    }

    // Check first if Product exists and then if user has the right to delete it
    const product = Products.findOne({ _id: extractedProductId || productId });
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    }

    const authUserId = Reaction.getUserId();

    if (!Reaction.hasPermission("createProduct", authUserId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    let productIds;

    if (!Array.isArray(productId)) {
      productIds = [productId];
    } else {
      productIds = productId;
    }
    const productsWithVariants = Products.find({
      // Don't "archive" products that are already marked deleted.
      isDeleted: {
        $ne: true
      },
      $or: [
        {
          _id: {
            $in: productIds
          }
        },
        {
          ancestors: {
            $in: productIds
          }
        }
      ]
    }).fetch();

    const ids = [];
    productsWithVariants.map((doc) => {
      ids.push(doc._id);
      return ids;
    });

    // Flag the product and all of it's variants as deleted.
    productsWithVariants.forEach((toArchiveProduct) => {
      Products.update(
        {
          _id: toArchiveProduct._id
        },
        {
          $set: {
            isDeleted: true
          }
        }, {
          selector: { type: toArchiveProduct.type }
        }
      );

      if (toArchiveProduct.type === "variant") {
        appEvents.emit("afterVariantSoftDelete", {
          variant: {
            ...toArchiveProduct,
            isDeleted: true
          },
          deletedBy: authUserId
        });
      } else {
        appEvents.emit("afterProductSoftDelete", {
          product: {
            ...toArchiveProduct,
            isDeleted: true
          },
          deletedBy: authUserId
        });
      }
    });

    const numFlaggedAsDeleted = Products.find({
      _id: {
        $in: ids
      },
      isDeleted: true
    }).count();

    if (numFlaggedAsDeleted > 0) {
      // Flag associated MediaRecords as deleted.
      MediaRecords.update(
        {
          "metadata.productId": {
            $in: ids
          },
          "metadata.variantId": {
            $in: ids
          }
        },
        {
          $set: {
            "metadata.isDeleted": true
          }
        }
      );
      return numFlaggedAsDeleted;
    }

    Logger.debug(`${numFlaggedAsDeleted} products have been flagged as deleted`);
  },

  /**
   * @name products/updateProductField
   * @memberof Methods/Products
   * @method
   * @summary update single product or variant field
   * @param {String} _id - product._id or variant._id to update
   * @param {String} field - key to update
   * @param {*} value - update property value
   * @todo rename it to something like "products/updateField" to  reflect
   * @todo we need to know which type of entity field belongs. For that we could
   * do something like: const type = Products.findOne(_id).type or transmit type
   * as param if it possible
   * latest changes. its used for products and variants
   * @return {Number} returns update result
   */
  "products/updateProductField"(_id, field, value) {
    check(_id, String);
    check(field, String);
    check(value, Match.OneOf(String, Object, Array, Boolean, Number));

    // Check first if Product exists and then if user has the right to alter it
    const doc = Products.findOne({ _id });
    if (!doc) {
      throw new ReactionError("not-found", "Product not found");
    }

    if (!Reaction.hasPermission("createProduct", this.userId, doc.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    const { type } = doc;
    let update;
    // handle booleans with correct typing
    if (value === "false" || value === "true") {
      const booleanValue = value === "true" || value === true;
      update = EJSON.parse(`{"${field}":${booleanValue}}`);
    } else if (field === "handle") {
      update = {
        // TODO: write function to ensure new handle is unique.
        // Should be a call similar to the line below.
        [field]: createHandle(Reaction.getSlug(value), _id) // handle should be unique
      };
    } else if (field === "title" && !doc.handle) {
      // update handle once title is set
      const handle = createHandle(Reaction.getSlug(value), _id);
      update = {
        [field]: value,
        handle
      };
    } else {
      const stringValue = EJSON.stringify(value);
      update = EJSON.parse(`{"${field}":${stringValue}}`);
    }

    // we need to use sync mode here, to return correct error and result to UI
    let result;
    try {
      result = updateCatalogProduct(
        this.userId,
        {
          _id
        },
        {
          $set: update
        },
        {
          selector: { type }
        }
      );
    } catch (err) {
      throw new ReactionError("server-error", err.message);
    }

    // If we get a result from the product update, emit update events
    if (result === 1) {
      if (type === "variant") {
        appEvents.emit("afterVariantUpdate", { _id, field, value });
      } else {
        appEvents.emit("afterProductUpdate", { _id, field, value });
      }
    }

    return update;
  },

  /**
   * @name products/updateProductTags
   * @memberof Methods/Products
   * @method
   * @summary method to insert or update tag with hierarchy
   * @param {String} productId - productId
   * @param {String} tagName - tagName
   * @param {String} tagId - tagId
   * @return {Number} return result
   */
  "products/updateProductTags"(productId, tagName, tagId) {
    check(productId, String);
    check(tagName, String);
    check(tagId, Match.OneOf(String, null));

    // Check first if Product exists and then if user has the right to alter it
    const product = Products.findOne(productId);
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    }

    if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    this.unblock();

    const newTag = {
      slug: Reaction.getSlug(tagName),
      name: tagName
    };

    const existingTag = Tags.findOne({
      slug: Reaction.getSlug(tagName)
    });

    if (existingTag) {
      const productCount = Products.find({
        _id: productId,
        hashtags: existingTag._id
      }).count();
      if (productCount > 0) {
        throw new ReactionError("server-error", "Existing Tag, Update Denied");
      }
      return updateCatalogProduct(
        this.userId,
        {
          _id: productId
        },
        {
          $push: {
            hashtags: existingTag._id
          }
        },
        {
          selector: { type: "simple" }
        }
      );
    } else if (tagId) {
      return Tags.update(tagId, { $set: newTag });
    }

    const newTagId = Meteor.call("shop/createTag", tagName, false);

    // if result is an Error object, we return it immediately
    if (typeof newTagId !== "string") {
      return newTagId;
    }

    return updateCatalogProduct(
      this.userId,
      {
        _id: productId
      },
      {
        $push: {
          hashtags: newTagId
        }
      },
      {
        selector: { type: "simple" }
      }
    );
  },

  /**
   * @name products/removeProductTag
   * @memberof Methods/Products
   * @method
   * @summary method to remove tag from product
   * @param {String} productId - productId
   * @param {String} tagId - tagId
   * @return {String} return update result
   */
  "products/removeProductTag"(productId, tagId) {
    check(productId, String);
    check(tagId, String);

    // Check first if Product exists and then if user has the right to alter it
    const product = Products.findOne(productId);
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    } else if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    updateCatalogProduct(
      this.userId,
      {
        _id: productId
      },
      {
        $pull: {
          hashtags: tagId
        }
      },
      {
        selector: { type: "simple" }
      }
    );
  },

  /**
   * @name products/setHandle
   * @memberof Methods/Products
   * @method
   * @summary copy of "products/setHandleTag", but without tag
   * @param {String} productId - productId
   * @returns {String} handle - product handle
   */
  "products/setHandle"(productId) {
    check(productId, String);

    // Check first if Product exists and then if user has the right to alter it
    const product = Products.findOne(productId);
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    } else if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    let handle = Reaction.getSlug(product.title);
    handle = createHandle(handle, product._id);
    updateCatalogProduct(
      this.userId,
      {
        _id: product._id
      },
      {
        $set: { handle, type: "simple" }
      }
    );

    return handle;
  },

  /**
   * @name products/setHandleTag
   * @memberof Methods/Products
   * @method
   * @summary set or toggle product handle
   * @param {String} productId - productId
   * @param {String} tagId - tagId
   * @return {String} return update result
   */
  "products/setHandleTag"(productId, tagId) {
    check(productId, String);
    check(tagId, String);
    // Check first if Product exists and then if user has the right to alter it
    const product = Products.findOne(productId);
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    } else if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    // eslint-disable-next-line require-jsdoc
    function getSet(handle) {
      return {
        $set: {
          handle,
          type: "simple"
        }
      };
    }

    const tag = Tags.findOne(tagId);
    // set handle
    if (product.handle === tag.slug) {
      let handle = Reaction.getSlug(product.title);
      handle = createHandle(handle, product._id);
      Products.update(product._id, getSet(handle));

      return handle;
    }
    // toggle handle
    const existingHandles = Products.find({
      handle: tag.slug
    }).fetch();
    // this is needed to take care about product's handle which(product) was
    // previously tagged.
    for (const currentProduct of existingHandles) {
      const currentProductHandle = createHandle(Reaction.getSlug(currentProduct.title), currentProduct._id);
      updateCatalogProduct(
        this.userId,
        {
          _id: currentProduct._id
        },
        getSet(currentProductHandle)
      );
    }

    updateCatalogProduct(
      this.userId,
      {
        _id: product._id
      },
      getSet(tag.slug)
    );

    return tag.slug;
  },

  /**
   * @name products/updateVariantsPosition
   * @memberof Methods/Products
   * @method
   * @description updates top level variant position index
   * @param {Array} sortedVariantIds - array of top level variant `_id`s
   * @param {String} shopId - The ID of the shop that owns all variants being sorted
   * @since 0.11.0
   * @return {Number} Products.update result
   */
  "products/updateVariantsPosition"(sortedVariantIds, shopId) {
    check(sortedVariantIds, [String]);
    check(shopId, String);

    // This checks to make sure the user has createProduct permissions for the active shop.
    // TODO: We should determine if that is the correct role that a user should have
    // to be permitted to re-arrange products on the grid
    if (!Reaction.hasPermission("createProduct", this.userId, shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    sortedVariantIds.forEach((id, index) => {
      updateCatalogProduct(
        this.userId,
        {
          _id: id,
          // Query on shop ID to be sure a different ID was not passed in to pass the permission check
          shopId,
          type: "variant"
        },
        {
          $set: { index }
        },
        {
          selector: { type: "variant" }
        }
      );
      Logger.debug(`Variant ${id} position was updated to index ${index}`);
    });
  },

  /**
   * @name products/updateMetaFields
   * @memberof Methods/Products
   * @method
   * @summary update product metafield
   * @param {String} productId - productId
   * @param {Object} updatedMeta - update object with metadata
   * @param {Object|Number|undefined|null} meta - current meta object, or a number index
   * @todo should this method works for variants also?
   * @return {Number} collection update result
   */
  "products/updateMetaFields"(productId, updatedMeta, meta) {
    check(productId, String);
    check(updatedMeta, Object);
    check(meta, Match.OneOf(Object, Number, undefined, null));

    // Check first if Product exists and then if user has the proper rights
    const product = Products.findOne(productId);
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    } else if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    // update existing metadata
    if (typeof meta === "object") {
      return updateCatalogProduct(
        this.userId,
        {
          _id: productId,
          metafields: meta
        },
        {
          $set: {
            "metafields.$": updatedMeta
          }
        },
        {
          selector: { type: "simple", metafields: meta }
        }
      );
    } else if (typeof meta === "number") {
      return updateCatalogProduct(
        this.userId,
        {
          _id: productId
        },
        {
          $set: {
            [`metafields.${meta}`]: updatedMeta
          }
        },
        {
          selector: { type: "simple", metafields: meta }
        }
      );
    }

    // adds metadata
    return updateCatalogProduct(
      this.userId,
      {
        _id: productId
      },
      {
        $addToSet: {
          metafields: updatedMeta
        }
      },
      {
        selector: { type: "simple" }
      }
    );
  },

  /**
   * @name products/removeMetaFields
   * @memberof Methods/Products
   * @method
   * @summary update product metafield
   * @param {String} productId - productId
   * @param {Object} metafields - metadata object to remove
   * @param {Object} type - optional product type for schema selection
   * @return {Number} collection update result
   */
  "products/removeMetaFields"(productId, metafields, type = "simple") {
    check(productId, String);
    check(metafields, Object);
    check(type, String);

    // Check first if Product exists and then if user has the proper rights
    const product = Products.findOne(productId);
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    } else if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    return updateCatalogProduct(
      this.userId,
      {
        _id: productId,
        type
      },
      {
        $pull: { metafields }
      }
    );
  },

  /**
   * @name products/toggleVisibility
   * @memberof Methods/Products
   * @method
   * @summary publish (visibility) of product
   * @todo hook into publishing flow
   * @param {String} productId - productId
   * @return {Boolean} product.isVisible
   */
  "products/toggleVisibility"(productId) {
    check(productId, String);

    // Check first if Product exists and then if user has the proper rights
    const product = Products.findOne({ _id: productId });
    if (!product) {
      throw new ReactionError("not-found", "Product not found");
    }

    if (!Reaction.hasPermission("createProduct", this.userId, product.shopId)) {
      throw new ReactionError("access-denied", "Access Denied");
    }

    const newFieldValue = !product.isVisible;

    const res = updateCatalogProduct(
      this.userId,
      {
        _id: productId
      },
      {
        $set: {
          isVisible: newFieldValue
        }
      },
      {
        selector: {
          type: product.type
        }
      }
    );

    if (res === 1) {
      if (product.type === "variant") {
        appEvents.emit("afterVariantUpdate", {
          _id: productId,
          field: "isVisible",
          value: newFieldValue
        });
      } else {
        appEvents.emit("afterProductUpdate", {
          _id: productId,
          field: "isVisible",
          value: newFieldValue
        });
      }
    }

    // if collection updated we return new `isVisible` state
    return res === 1 && newFieldValue;
  }
});
