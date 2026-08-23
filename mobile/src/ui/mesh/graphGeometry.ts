/**
 * Route geometry for the topology view.
 *
 * Split out of `MeshGraph` because it is arithmetic and nothing else — no
 * React, no `react-native` — which is the line this project draws for what can
 * be tested off a phone. `stopsAlong` in particular has a hard requirement it
 * cannot state in its type: `Animated.interpolate` throws on an input range
 * that is not strictly increasing, and two nodes landing on the same point is a
 * thing that happens on a small board.
 */

export interface Point {
    x: number;
    y: number;
}

export function pathLength(points: Point[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return total;
}

/**
 * Where each corner falls as a fraction of the whole route.
 *
 * `Animated.interpolate` requires a strictly increasing input range, so a
 * zero-length segment — two nodes that happen to land on the same point — would
 * throw rather than degrade. Callers drop empty routes before they get here;
 * this nudges any remaining duplicate rather than risking it.
 */
export function stopsAlong(points: Point[]): number[] {
    const total = pathLength(points) || 1;
    const stops: number[] = [0];
    let run = 0;
    for (let i = 1; i < points.length; i++) {
        run += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        stops.push(Math.max(run / total, stops[i - 1] + 1e-4));
    }
    return stops;
}

/** The first `fraction` of a route, ending wherever along it that lands. */
export function cutPath(points: Point[], fraction: number): Point[] {
    const target = pathLength(points) * fraction;
    const out: Point[] = [points[0]];
    let run = 0;
    for (let i = 1; i < points.length; i++) {
        const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        if (run + seg >= target) {
            const k = seg === 0 ? 0 : (target - run) / seg;
            out.push({
                x: points[i - 1].x + (points[i].x - points[i - 1].x) * k,
                y: points[i - 1].y + (points[i].y - points[i - 1].y) * k,
            });
            return out;
        }
        run += seg;
        out.push(points[i]);
    }
    return out;
}
