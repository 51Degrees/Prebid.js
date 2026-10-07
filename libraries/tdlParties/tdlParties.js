import { ajax } from '../../src/ajax.js';

/**
 * Party lists for terms documents named by a Terms Document Locator (TDL).
 *
 * A party that has accepted a terms document publishes the domains of the
 * other parties it has those terms with, in a text file on its own domain.
 * The file is found from the address of the terms document, by putting the
 * address without its scheme after `/.well-known/tdl/`, so the terms at
 * `https://m4ow.uk/mtm/2.txt` have their party list for `example.com` at
 * `https://example.com/.well-known/tdl/m4ow.uk/mtm/2.txt`.
 *
 * Data created under a terms document may pass from one party to another
 * only where each lists the other for that document, which is what
 * `agreed` answers. A list that cannot be fetched, or that has not been
 * fetched yet, proves nothing, so the answer is then false.
 *
 * Every list is kept in memory and in local storage, where storage is
 * allowed, and is asked for again only when the copy is older than `ttl`.
 * A failed fetch is remembered for the shorter `failureTtl`, so that a
 * party with no file is not asked on every auction. Two questions about
 * the same list while a fetch is in flight share the one request.
 */

export const WELL_KNOWN_PATH = '/.well-known/tdl/';
export const STORAGE_KEY_PREFIX = '__tdl_parties:';
export const DEFAULT_TTL = 24 * 60 * 60 * 1000;
export const DEFAULT_FAILURE_TTL = 60 * 60 * 1000;

/**
 * The address of the list of parties a domain has a terms document with.
 *
 * @param {string} domain the party that publishes the list
 * @param {string} termsUrl the address of the terms document
 * @returns {string} the address of the list
 */
export function partiesUrl(domain, termsUrl) {
  const withoutScheme = String(termsUrl)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[?#].*$/, '');
  return `https://${normaliseDomain(domain)}${WELL_KNOWN_PATH}${withoutScheme}`;
}

/**
 * The domains in a party list. The list is text with one domain to a line.
 * Blank lines are ignored, and so is anything from a `#` to the end of its
 * line. Domains are compared without regard to case.
 *
 * @param {string} text the body of the list
 * @returns {string[]} the domains, in lower case
 */
export function parseParties(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const domains = text.split(/\r?\n/)
    .map((line) => normaliseDomain(line.replace(/#.*$/, '')))
    .filter((line) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(line));
  return Array.from(new Set(domains));
}

function normaliseDomain(domain) {
  return String(domain).trim().toLowerCase();
}

function defaultGet(url) {
  return new Promise((resolve, reject) => {
    ajax(url, { success: resolve, error: reject }, null, { method: 'GET', withCredentials: false });
  });
}

/**
 * @param {Object} [options]
 * @param {Object} [options.storage] a storage manager, used where local
 *        storage is enabled
 * @param {number} [options.ttl] how long a fetched list is used, in
 *        milliseconds
 * @param {number} [options.failureTtl] how long a failed fetch is
 *        remembered, in milliseconds
 * @param {function(string): Promise<string>} [options.get] fetches the
 *        body of an address
 * @param {function(): number} [options.now] the time in milliseconds
 * @returns {{agreed: function(string, string, string[]): Promise<boolean>}}
 */
export function tdlPartiesFactory({
  storage,
  ttl = DEFAULT_TTL,
  failureTtl = DEFAULT_FAILURE_TTL,
  get = defaultGet,
  now = () => Date.now(),
} = {}) {
  // url -> { t: time fetched, d: domains, or null where the fetch failed }
  const memory = new Map();
  // url -> the promise of the fetch in flight for it
  const inFlight = new Map();

  const fresh = (entry) => !!entry && typeof entry.t === 'number' &&
    (entry.d === null || Array.isArray(entry.d)) &&
    now() - entry.t < (entry.d === null ? failureTtl : ttl);

  function stored(url) {
    try {
      if (storage && storage.localStorageIsEnabled()) {
        return JSON.parse(storage.getDataFromLocalStorage(STORAGE_KEY_PREFIX + url));
      }
    } catch (e) {}
    return null;
  }

  function keep(url, domains) {
    const entry = { t: now(), d: domains };
    memory.set(url, entry);
    try {
      if (storage && storage.localStorageIsEnabled()) {
        storage.setDataInLocalStorage(STORAGE_KEY_PREFIX + url, JSON.stringify(entry));
      }
    } catch (e) {}
    return entry;
  }

  // The list at an address, from the copy held where that is fresh and
  // from the address otherwise. Resolves to the domains, or to null where
  // the list could not be fetched.
  function list(url) {
    let entry = memory.get(url);
    if (!fresh(entry)) {
      entry = stored(url);
      if (fresh(entry)) {
        memory.set(url, entry);
      }
    }
    if (fresh(entry)) {
      return Promise.resolve(entry.d);
    }
    if (!inFlight.has(url)) {
      const settle = (domains) => {
        inFlight.delete(url);
        return keep(url, domains).d;
      };
      inFlight.set(url, Promise.resolve()
        .then(() => get(url))
        .then((text) => settle(parseParties(text)), () => settle(null)));
    }
    return inFlight.get(url);
  }

  const lists = (domain, termsUrl, other) => list(partiesUrl(domain, termsUrl))
    .then((domains) => Array.isArray(domains) && domains.includes(normaliseDomain(other)));

  return {
    /**
     * Whether data created under every one of the terms documents may pass
     * from the sender to the receiver, being that each lists the other for
     * each document.
     *
     * @param {string} sender the domain of the party passing the data on
     * @param {string} receiver the domain of the party it would go to
     * @param {string[]} termsUrls the addresses of the terms documents
     * @returns {Promise<boolean>} false where there are no terms documents
     */
    agreed(sender, receiver, termsUrls) {
      if (!sender || !receiver || !Array.isArray(termsUrls) || termsUrls.length === 0) {
        return Promise.resolve(false);
      }
      return Promise.all(termsUrls.map((termsUrl) => Promise.all([
        lists(sender, termsUrl, receiver),
        lists(receiver, termsUrl, sender),
      ]))).then((answers) => answers.every(([senderLists, receiverLists]) => senderLists && receiverLists));
    },
  };
}
