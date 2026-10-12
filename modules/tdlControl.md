# TDL Control Module

## Overview

    Module Name: TDL Control
    Module Type: Other
    Maintainer: support@51degrees.com

## Description

Data in a bid request can be created under a terms document, which the data names with a Terms Document Locator (TDL), being the address of the document. This module keeps such data from every bidder that has not agreed those terms with the publisher.

An element of a bid request names its terms in `tdl`, or in `ext.tdl`, as a list of addresses.

```json
{
  "source": "51d.es",
  "uids": [{ "id": "...", "atype": 1 }],
  "ext": { "tdl": ["https://m4ow.uk/mtm/2.txt"] }
}
```

A request in which nothing names terms is left exactly as it was, and the auction is not delayed.

## The rule

Each party publishes, on its own domain, the domains of the parties it has a terms document with. The list for a document is found by putting the document's address, without its scheme, after `/.well-known/tdl/`. The parties `publisher.example` has the terms at `https://m4ow.uk/mtm/2.txt` with are listed at `https://publisher.example/.well-known/tdl/m4ow.uk/mtm/2.txt`.

The list is a text file with one domain to a line. Blank lines are ignored, and so is anything from a `#` to the end of its line.

```
# Parties publisher.example has the Model Terms for Marketing 2 with
ssp.example
exchange.example
```

An element that names terms is passed to a bidder, with everything the element holds, only where all of these are true.

1. The publisher has set its domain.
2. The bidder's adapter declares the bidder's domain.
3. For every terms document the element names, the publisher's list names the bidder's domain.
4. For every terms document the element names, the bidder's list names the publisher's domain.

Where any of them is not true, the element and everything it holds is left out of that bidder's request. The rest of the request is not changed.

The rule covers every element that names terms, whichever module added it, in the first party data of the request and of each impression, for bidders reached from the page and through Prebid Server.

## Configuration

```javascript
pbjs.setConfig({
  tdl: {
    domain: 'publisher.example',
    auctionDelay: 300
  }
});
```

| Name | Type | Description | Default |
| :--- | :--- | :--- | :--- |
| tdl.domain | String | The domain the publisher is known by in other parties' lists, and on which its own lists are published under `/.well-known/tdl/`. Where it is not set, nothing that names terms is passed to any bidder. | none |
| tdl.auctionDelay | Number | The longest an auction waits, in milliseconds, for lists it does not hold. A list that has not arrived by then counts as not naming anyone for that auction, and is used from the next auction on. Set 0 to never wait. | 300 |

## Bidder adapters

A bidder adapter declares the domain its lists are published on as `tdlDomain` on its spec.

```javascript
export const spec = {
  code: 'example',
  tdlDomain: 'ssp.example',
  // ...
};
```

A bidder whose adapter declares no `tdlDomain` receives nothing that names terms. An alias uses the domain of the adapter it is an alias of. The domain has to match a line of the publisher's list exactly, so `eu.ssp.example` is not covered by `ssp.example`.

## Caching

A list is fetched once and kept for 24 hours, in local storage where Prebid's storage rules allow it and in memory otherwise. A list that could not be fetched is not asked for again for an hour. Lists are fetched without credentials, and a list on another domain has to be served with an `Access-Control-Allow-Origin` header that lets the page read it.
