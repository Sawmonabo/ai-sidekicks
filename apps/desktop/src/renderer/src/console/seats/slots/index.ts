// The slots sub-module's door: the one seat a sibling takes.
//
// `composer/composer-seat.ts` holds the composer's single-slot claim through
// `SingleSlotSeat`, which is the whole measured edge into this directory. The
// timeline row slot, the owner slot, the inline-card seats, and the sidebar sections
// are read by the family door and by nothing beside it.
export { SingleSlotSeat } from "./single-slot-seat.js";
