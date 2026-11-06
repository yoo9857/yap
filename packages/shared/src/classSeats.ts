/**
 * Classroom plots (teacher's F2 → 자리 배치): every online student gets a plot of their own,
 * `PLOT.width` × `PLOT.depth` (15 × 20) cells, fenced off from the next one and signed with their
 * name. The plots lie side by side in rows in front of the teacher. Pure, shared by the server (which
 * sends each student its spot) and the client (which draws the fences and signs).
 *
 * - Plots are axis-aligned with the voxel grid: the teacher's heading is snapped to the nearest
 *   quarter turn, and every plot edge lies on a cell boundary.
 * - At most `PLOT_COLS` plots per row; the last row is centred. Rows run away from the teacher, the
 *   first one starting `PLOT_FRONT` cells ahead. Each row reads left → right as the teacher sees it.
 * - A student stands `PLOT_INSET` cells inside the front of their plot, facing the teacher.
 *
 * Yaw convention (the client's): a heading `yaw` looks along (sin yaw, cos yaw) in x/z.
 */
export const PLOT = { width: 15, depth: 20 } as const;
/** Cells between the teacher's cell and the front edge of the first row of plots. */
export const PLOT_FRONT = 3;
/** Plots side by side in one row. */
export const PLOT_COLS = 6;
/** How far inside the plot's front edge its student stands (to the cell centre). */
export const PLOT_INSET = 2.5;

export interface SeatSpot {
  /** Where the student stands (absolute), inside the front of their plot. */
  pos: [number, number, number];
  /** Facing the teacher. */
  yaw: number;
}

/** A plot's four corners (absolute x/z) from its student's spot: front-left, front-right, back-right, back-left. */
export function plotCorners(spot: SeatSpot): [number, number][] {
  const fx = Math.round(Math.sin(spot.yaw)); // toward the teacher
  const fz = Math.round(Math.cos(spot.yaw));
  const ax = fz; // across the plot
  const az = -fx;
  const [x, , z] = spot.pos;
  const front = PLOT_INSET; // toward the teacher
  const back = PLOT_INSET - PLOT.depth;
  const half = PLOT.width / 2;
  const at = (d: number, a: number): [number, number] => [x + fx * d + ax * a, z + fz * d + az * a];
  return [at(front, -half), at(front, half), at(back, half), at(back, -half)];
}

/**
 * Spots for `count` students in front of a teacher standing at `teacher` (absolute field
 * coordinates) facing `teacherYaw`: one per plot, front row first.
 */
export function seatLayout(count: number, teacher: readonly [number, number, number], teacherYaw: number): SeatSpot[] {
  if (count <= 0) return [];
  const quarter = Math.round(teacherYaw / (Math.PI / 2));
  const yaw = quarter * (Math.PI / 2);
  const fx = Math.round(Math.sin(yaw));
  const fz = Math.round(Math.cos(yaw));
  // the teacher's right hand as the teacher sees it, so a row reads left → right from the front
  const rx = -fz;
  const rz = fx;
  // the teacher's cell centre: a plot (odd width) centred on a cell centre has its edges on cell boundaries
  const cx = Math.floor(teacher[0]) + 0.5;
  const cz = Math.floor(teacher[2]) + 0.5;
  const cols = Math.min(count, PLOT_COLS);
  const spots: SeatSpot[] = [];
  const facing = yaw + Math.PI;
  for (let row = 0; spots.length < count; row++) {
    const inRow = Math.min(cols, count - spots.length);
    // the front edge half a cell past the teacher's cell + PLOT_FRONT, the student PLOT_INSET inside
    const ahead = 0.5 + PLOT_FRONT + row * PLOT.depth + PLOT_INSET;
    // an even row would centre on a cell boundary: shift it half a cell so plots stay on the grid
    const shift = inRow % 2 === 0 ? 0.5 : 0;
    for (let i = 0; i < inRow; i++) {
      const across = (i - (inRow - 1) / 2) * PLOT.width + shift;
      spots.push({ pos: [cx + fx * ahead + rx * across, teacher[1], cz + fz * ahead + rz * across], yaw: facing });
    }
  }
  return spots;
}
