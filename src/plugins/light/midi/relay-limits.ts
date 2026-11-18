/**
 * The Web MIDI relay's limits, shared by the page that sends and the server that takes (docs/specs/midi.md, « Web MIDI »).
 * Pure: imported by the web as by the server, so the two never disagree.
 */

/** The most messages one `midi.in` batch carries: the server refuses more, the page cuts its batches to this. */
export const MAX_BATCH = 512;
