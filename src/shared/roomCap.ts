// Non-PACE (SAL/SAN) distributors carry NO 1.2×Norm cap, so the engine gives them an "unlimited" base-stock room —
// the backend sentinel NO_NORM_CAP (1e9). Real rooms are at most a few thousand cases, so a room this large means the
// DB is uncapped. On such a row BOTH the "1.2×Norm" and the "Room" columns should read a clear message instead of the
// raw floor(1.2×Norm) / 999,999,9xx sentinel, so a reader sees at a glance it's a Non-PACE DB with no 1.2×Norm limit.
export const UNCAPPED_ROOM_MIN = 1e8;
export const isUncappedRoom = (v: number | null | undefined): boolean => Number(v ?? 0) >= UNCAPPED_ROOM_MIN;
export const NO_CAP_LABEL = 'No cap';                                   // shown in the 1.2×Norm + Room columns
export const NO_CAP_TIP = 'Non-PACE distributor — no 1.2×Norm cap (unlimited base-stock room)';
