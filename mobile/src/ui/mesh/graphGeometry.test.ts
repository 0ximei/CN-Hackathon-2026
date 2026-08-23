import { describe, expect, it } from 'vitest';

import { cutPath, pathLength, stopsAlong, type Point } from './graphGeometry';

const p = (x: number, y: number): Point => ({ x, y });

/** Self at the origin, a relay 30 to the right, a two-hop node 40 beyond it. */
const TWO_HOP: Point[] = [p(0, 0), p(30, 0), p(70, 0)];

describe('graph geometry', () => {
    it('measures a route corner to corner, not end to end', () => {
        // The distinction only shows up on a bent path, which is the whole
        // point of drawing one: a right-angled route is longer than the
        // straight line a direct link would have been.
        expect(pathLength([p(0, 0), p(30, 0), p(30, 40)])).toBe(70);
        expect(pathLength([p(0, 0), p(30, 40)])).toBe(50);
    });

    /**
     * The stops place each corner by distance, not by index.
     *
     * Spacing them evenly instead would make the packet cross a short leg and a
     * long leg in the same time — it would visibly slow down over the far half
     * of an asymmetric route, which reads as the relay being slow rather than
     * as the leg being longer.
     */
    it('spaces corners by distance travelled', () => {
        expect(stopsAlong(TWO_HOP)).toEqual([0, 30 / 70, 1]);
    });

    /**
     * `Animated.interpolate` throws on an input range that is not strictly
     * increasing, and coincident nodes are not hypothetical — a peer whose
     * relay sits at the same bearing lands on top of it on a narrow board.
     */
    it('never emits a flat or backwards input range', () => {
        for (const route of [
            [p(10, 10), p(10, 10), p(50, 10)],
            [p(0, 0), p(0, 0), p(0, 0)],
            [p(5, 5), p(5, 5)],
        ]) {
            const stops = stopsAlong(route);
            expect(stops).toHaveLength(route.length);
            expect(stops[0]).toBe(0);
            for (let i = 1; i < stops.length; i++) {
                expect(stops[i], `stop ${i} of ${JSON.stringify(stops)}`).toBeGreaterThan(
                    stops[i - 1],
                );
            }
        }
    });

    /**
     * A dropped packet dies partway along the route it was actually on.
     *
     * Scaling the endpoint instead — which is what this did while every route
     * was a single straight line — puts the packet in open space beside a
     * bent path rather than on the leg it failed on.
     */
    it('cuts a dropped packet short along the route', () => {
        const cut = cutPath(TWO_HOP, 0.5);
        // Half of 70 is 35, which is five past the corner.
        expect(cut).toEqual([p(0, 0), p(30, 0), p(35, 0)]);
        expect(pathLength(cut)).toBeCloseTo(35);
    });

    it('keeps a cut inside the first leg when it falls there', () => {
        const cut = cutPath(TWO_HOP, 0.2);
        expect(cut).toEqual([p(0, 0), p(14, 0)]);
    });

    it('leaves a whole route whole', () => {
        expect(pathLength(cutPath(TWO_HOP, 1))).toBeCloseTo(70);
    });
});
