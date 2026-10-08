/**
 * Keeps any element of a bid request that names the terms it was created
 * under, in `tdl` or in `ext.tdl`, from every bidder that has not agreed
 * those terms with the publisher. The rule is in libraries/tdlParties, and
 * this module puts it in force for a build that has no other module doing
 * so.
 */
import { installTdlControl } from '../libraries/tdlParties/tdlControl.js';

installTdlControl();
