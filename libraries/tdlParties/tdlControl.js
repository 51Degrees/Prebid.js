import adapterManager from '../../src/adapterManager.js';
import { config } from '../../src/config.js';
import { startAuction } from '../../src/prebid.js';
import { getCoreStorageManager } from '../../src/storageManager.js';
import { deepClone, isPlainObject, logMessage, logWarn, mergeDeep } from '../../src/utils.js';
import { delay } from '../../src/utils/promise.js';
import { tdlPartiesFactory } from './tdlParties.js';

/**
 * Keeps data created under a terms document from any bidder that has not
 * accepted those terms with the party passing the data on.
 *
 * An element of a bid request names the terms documents it was created
 * under in `tdl` or in `ext.tdl`, as a list of addresses (a Terms Document
 * Locator). The party passing the request on is the sender, set as
 * `tdl.domain` in the Prebid configuration. Each bidder is a receiver,
 * whose adapter declares its domain as `tdlDomain` on its spec. An element
 * that names terms goes to a bidder, with everything the element holds,
 * only where the sender and that bidder each list the other for every
 * document named (see tdlParties.js). Where either has set no domain the
 * element goes to no one. A request in which nothing names terms is left
 * exactly as it was.
 *
 * The lists are asked for before the auction, and the rule is applied
 * where core makes each bidder's request, so it covers the data of every
 * module, for bidders reached from the page and through Prebid Server.
 */

export const MODULE_NAME = 'tdlControl';
export const DEFAULT_AUCTION_DELAY = 300;

const asDomain = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

const adapterDomain = (bidder) =>
  asDomain(adapterManager.getBidAdapter(adapterManager.resolveAlias(bidder))?.getSpec?.()?.tdlDomain);

/**
 * The terms documents an element names.
 *
 * @param {*} node a part of a bid request
 * @returns {string[]} the addresses in `tdl` and in `ext.tdl`
 */
export function termsOf(node) {
  if (!isPlainObject(node)) {
    return [];
  }
  return [].concat(node.tdl, isPlainObject(node.ext) ? node.ext.tdl : [])
    .filter((terms) => typeof terms === 'string' && terms !== '');
}

// Every terms document named anywhere in a part of a bid request.
function termsIn(node, found = new Set()) {
  if (Array.isArray(node)) {
    node.forEach((item) => termsIn(item, found));
  } else if (isPlainObject(node)) {
    termsOf(node).forEach((terms) => found.add(terms));
    Object.keys(node).forEach((key) => termsIn(node[key], found));
  }
  return found;
}

/**
 * Removes from a part of a bid request every element that names terms the
 * receiver may not have, with everything the element holds.
 *
 * @param {*} node the part, which is changed in place
 * @param {function(string[]): boolean} allowed whether the receiver may
 *        have what was created under these terms documents
 * @returns {boolean} false where the part is itself such an element
 */
export function prune(node, allowed) {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (!prune(node[i], allowed)) {
        node.splice(i, 1);
      }
    }
  } else if (isPlainObject(node)) {
    const terms = termsOf(node);
    if (terms.length > 0 && !allowed(terms)) {
      return false;
    }
    Object.keys(node).forEach((key) => {
      if (!prune(node[key], allowed)) {
        delete node[key];
      }
    });
  }
  return true;
}

/**
 * Takes out of the data every receiver shares each part that names terms,
 * and gives each receiver its own copy of that part with what the receiver
 * may not have removed.
 *
 * A part is an element that names terms, or the whole item of a list in
 * which something names terms. The whole item moves so that what a
 * receiver may have stays inside the item it belongs to, and the lists
 * core merges for each receiver hold no item twice.
 *
 * @param {Object} shared the data every receiver gets, changed in place
 * @param {Array<{allowed: function(string[]): boolean, tree: Object}>} receivers
 *        each receiver's own data, where `tree` is replaced when a part is
 *        added to it
 */
export function share(shared, receivers) {
  // The receiver's own data is merged last, as core merges it, so that it
  // still wins over what all receivers shared.
  const give = (path, part) => receivers.forEach((receiver) => {
    const copy = deepClone(part);
    if (prune(copy, receiver.allowed) && (!Array.isArray(copy) || copy.length > 0)) {
      receiver.tree = mergeDeep({}, path.reduceRight((inner, key) => ({ [key]: inner }), copy), receiver.tree);
    }
  });

  if (termsOf(shared).length > 0) {
    give([], shared);
    Object.keys(shared).forEach((key) => delete shared[key]);
    return;
  }

  const walk = (node, path) => Object.keys(node).forEach((key) => {
    const value = node[key];
    const here = path.concat(key);
    if (Array.isArray(value)) {
      const parts = value.filter((item) => termsIn(item).size > 0);
      if (parts.length > 0) {
        const rest = value.filter((item) => !parts.includes(item));
        if (rest.length > 0) {
          node[key] = rest;
        } else {
          delete node[key];
        }
        give(here, parts);
      }
    } else if (isPlainObject(value)) {
      if (termsOf(value).length > 0) {
        delete node[key];
        give(here, value);
      } else {
        walk(value, here);
      }
    }
  });
  walk(shared, []);
}

/**
 * @param {Object} [options]
 * @param {Object} [options.parties] the party lists (see tdlParties.js)
 * @param {function(): Object} [options.settings] the `tdl` configuration
 * @param {function(string): string} [options.domainOf] the domain a
 *        bidder's adapter declares
 * @returns {{loadLists: function, applyToRequest: function, applyToImps: function}}
 *          the three hooks `installTdlControl` attaches
 */
export function tdlControlFactory({
  parties = tdlPartiesFactory({ storage: getCoreStorageManager(MODULE_NAME) }),
  settings = () => config.getConfig('tdl') || {},
  domainOf = adapterDomain,
} = {}) {
  // Whether a bidder may have what was created under some terms documents,
  // from the lists held now.
  const allowedFor = (bidder) => {
    const sender = asDomain(settings().domain);
    const receiver = bidder ? domainOf(bidder) : '';
    return (terms) => parties.agreedNow(sender, receiver, terms);
  };

  const biddersOf = (adUnits) => [].concat(...(adUnits || []).map((adUnit) => adUnit.bids || []))
    .map((bid) => bid.bidder)
    .filter(Boolean);

  // A receiver's own data with what it may not have removed. The data is
  // copied before anything is removed, because the lists in it can hold the
  // same items as another receiver's lists.
  function pruned(tree, allowed) {
    if (termsIn(tree).size === 0) {
      return tree;
    }
    const copy = deepClone(tree);
    return prune(copy, allowed) ? copy : {};
  }

  // Gives the data all receivers share to each of them as far as the rule
  // allows, and removes from each receiver's own data what it may not have.
  function apply(shared, receivers) {
    receivers.forEach((receiver) => {
      receiver.tree = receiver.tree && pruned(receiver.tree, receiver.allowed);
    });
    if (isPlainObject(shared)) {
      share(shared, receivers);
    }
  }

  /**
   * Asks, before an auction, for the lists the auction needs and does not
   * hold, and waits for them no longer than `tdl.auctionDelay`. An auction
   * in which nothing names terms, or whose lists are all held, is not
   * delayed.
   */
  function loadLists(next, auction) {
    const proceed = () => next.call(this, auction);
    const { ortb2Fragments = {}, adUnits = [] } = auction || {};
    const terms = termsIn([ortb2Fragments, adUnits.map((adUnit) => [adUnit.ortb2Imp, (adUnit.bids || []).map((bid) => bid.ortb2Imp)])]);
    if (terms.size === 0) {
      return proceed();
    }
    const { domain, auctionDelay = DEFAULT_AUCTION_DELAY } = settings();
    const sender = asDomain(domain);
    if (!sender) {
      logWarn(`${MODULE_NAME}: tdl.domain is not set, so nothing that names terms is passed to any bidder`);
      return proceed();
    }
    const bidders = biddersOf(adUnits).concat(Object.keys(ortb2Fragments.bidder || {}));
    const undeclared = bidders.filter((bidder, i) => bidders.indexOf(bidder) === i && !domainOf(bidder));
    if (undeclared.length > 0) {
      logMessage(`${MODULE_NAME}: no tdlDomain is declared for ${undeclared.join(', ')}, which receive nothing that names terms`);
    }
    const receivers = Array.from(new Set(bidders.map(domainOf).filter(Boolean)))
      .filter((receiver) => !parties.known(sender, receiver, Array.from(terms)));
    if (receivers.length === 0) {
      return proceed();
    }
    const loaded = Promise.all(receivers.map((receiver) => parties.agreed(sender, receiver, Array.from(terms))));
    if (!(auctionDelay > 0)) {
      return proceed();
    }
    Promise.race([loaded, delay(auctionDelay)]).then(proceed, proceed);
  }

  /**
   * Applies the rule to the first party data of the request, before core
   * merges it for each bidder and hands it to Prebid Server.
   */
  function applyToRequest(next, adUnits, auctionStart, auctionId, cbTimeout, labels, ortb2Fragments, ...rest) {
    if (isPlainObject(ortb2Fragments)) {
      const own = ortb2Fragments.bidder || {};
      const bidders = biddersOf(adUnits).concat(Object.keys(own));
      const receivers = bidders.filter((bidder, i) => bidders.indexOf(bidder) === i)
        .map((bidder) => ({ bidder, allowed: allowedFor(bidder), tree: own[bidder] }));
      apply(ortb2Fragments.global, receivers);
      receivers.filter((receiver) => receiver.tree).forEach((receiver) => {
        own[receiver.bidder] = receiver.tree;
        ortb2Fragments.bidder = own;
      });
    }
    return next.call(this, adUnits, auctionStart, auctionId, cbTimeout, labels, ortb2Fragments, ...rest);
  }

  /**
   * Applies the rule to the data of each impression. A bidder reached from
   * the page has its own copy by now. The ad units copied for Prebid
   * Server still share theirs between the bidders on each ad unit.
   */
  function applyToImps(next, bidderRequests) {
    (bidderRequests || []).forEach((bidderRequest) => {
      (bidderRequest.bids || []).forEach((bid) => {
        if (bid.ortb2Imp) {
          bid.ortb2Imp = pruned(bid.ortb2Imp, allowedFor(bid.bidder));
        }
      });
      (bidderRequest.adUnitsS2SCopy || []).forEach((adUnit) => {
        const receivers = (adUnit.bids || []).filter((bid) => bid.bidder)
          .map((bid) => ({ bid, allowed: allowedFor(bid.bidder), tree: bid.ortb2Imp }));
        apply(adUnit.ortb2Imp, receivers);
        receivers.filter((receiver) => receiver.tree).forEach((receiver) => {
          receiver.bid.ortb2Imp = receiver.tree;
        });
      });
    });
    return next.call(this, bidderRequests);
  }

  return { loadLists, applyToRequest, applyToImps };
}

let installed;

/**
 * Puts the rule in force for every auction. Each module that creates data
 * under terms calls this, and calling it again does nothing.
 */
export function installTdlControl() {
  if (!installed) {
    installed = tdlControlFactory();
    // After every hook that adds to a request, which all have a higher
    // priority, so that the terms they name are seen.
    startAuction.before(installed.loadLists, 1);
    adapterManager.makeBidRequests.before(installed.applyToRequest, 1);
    adapterManager.makeBidRequests.after(installed.applyToImps);
  }
}
