import { parseDocument } from '@core/lib/chunk';

/**
 * Documents for tests to work with, now that nothing ships a corpus.
 *
 * The app starts empty and fills from what people upload and what the mesh
 * carries, so a fixture is the only place a "node that already knows things"
 * comes from. Kept deliberately realistic in shape rather than minimal:
 * multiple headed sections per document, and paragraphs long enough that a
 * snippet fills its 200-byte field. `wiresize.test.ts` measures the worst-case
 * announcement against these, and a fixture of `'a'.repeat(50)` would measure a
 * packet no real document produces.
 */
export interface FixtureDoc {
    file: string;
    markdown: string;
}

export const FIXTURE_DOCS: FixtureDoc[] = [
    {
        file: 'bleeding.md',
        markdown: `# Bleeding and Wounds
source: fixture

## Severe external bleeding
Apply firm, direct pressure to the wound with the heel of your hand, using any clean cloth as padding. Press hard enough that it is uncomfortable, because light pressure does not stop arterial bleeding and a casualty can lose a fatal volume in minutes.
Do not remove soaked dressings. Add more padding on top and keep pressing, since lifting the dressing tears away the clot that is forming underneath it.

## Tourniquets
If a limb is bleeding uncontrollably and direct pressure has failed, apply a tourniquet five to seven centimetres above the wound and never over a joint. Tighten until the bleeding stops and the pulse below it disappears, then write the time of application somewhere it will be seen.
Once applied, do not loosen or remove it. Loosening releases accumulated toxins into the circulation and restarts the bleeding that the tourniquet was placed to stop.

## Recognising infection
Infection usually appears one to three days after injury. Watch for spreading redness, pain that increases rather than settles, swelling, heat, pus, or a foul smell coming from the dressing.
Mark the edge of the redness with a pen and note the time. If it advances past the mark within a few hours the infection is progressing quickly and needs antibiotics.`,
    },
    {
        file: 'burns.md',
        markdown: `# Burns and Scalds
source: fixture

## Cooling a burn
Cool the burn under cool running water for at least twenty minutes, and start as soon as possible — cooling still helps up to three hours after the injury. Do not use ice, which causes further tissue damage on top of the burn.
Remove clothing and jewellery from the area before it begins to swell, unless the fabric is stuck to the skin, in which case leave it alone and cool over the top of it.

## Covering a burn
Cover the cooled burn loosely with cling film laid in sheets rather than wrapped around the limb, because wrapping constricts as the tissue swells. A clean plastic bag works for a hand or a foot.
Do not apply butter, oil, toothpaste or any ointment to a fresh burn. They trap heat in the tissue and have to be cleaned off before the burn can be assessed.

## When a burn needs help
Any burn larger than the casualty's palm, any burn to the face, hands, feet or genitals, and any burn that looks white, leathery or charred needs medical assessment rather than field treatment.`,
    },
    {
        file: 'water.md',
        markdown: `# Drinking Water
source: fixture

## Boiling
Bringing water to a rolling boil for one full minute kills bacteria, viruses and protozoa, and is the most reliable treatment available without equipment. Above two thousand metres, boil for three minutes.
Let it cool covered. Water left open to the air after boiling can be recontaminated by whatever settles into it.

## Filtering before treatment
Cloudy water should be filtered through a cloth or allowed to settle before boiling or chemical treatment, because suspended sediment shields organisms from both heat and chemicals.
A sand and charcoal filter improves clarity and taste but does not make water safe on its own, and treating filtered water is still necessary.`,
    },
];

/** Structural, so both catalog implementations satisfy it without importing either. */
interface Ingests {
    ingestParsed(
        parsed: ReturnType<typeof parseDocument>,
        originId: number,
        provenance: 'local' | 'mesh',
        bodyFilter?: (docId: number) => boolean,
    ): Promise<unknown>;
}

/** Puts the fixture into a catalog as documents this node uploaded. */
export async function loadFixtures(
    catalog: Ingests,
    originId: number,
    bodyFilter?: (docId: number) => boolean,
): Promise<void> {
    for (const doc of FIXTURE_DOCS) {
        await catalog.ingestParsed(parseDocument(doc.file, doc.markdown), originId, 'local', bodyFilter);
    }
}

/**
 * Filler, for tests that care how *much* a node knows rather than what.
 *
 * The airtime budget and the render-rate budget are both about volume: they
 * measure a node with a real library, and a node holding three documents does
 * not exercise either. Generated rather than written out because the content is
 * genuinely irrelevant to them — what matters is the shape, so sections and
 * paragraphs are sized like the real ones and snippets still fill their field.
 */
function syntheticDoc(i: number): FixtureDoc {
    const topic = `Field Note ${i}`;
    const sections = [0, 1, 2].map((n) => {
        const body = `Step ${n + 1} of the ${topic.toLowerCase()} procedure is carried out before the casualty is moved, because moving them first makes the assessment unreliable and can worsen an injury that has not yet been found. Check the result, record the time, and repeat if the condition changes.`;
        return `## Procedure step ${n + 1}\n${body}\n${body}`;
    });
    return {
        file: `field-note-${i}.md`,
        markdown: `# ${topic}\nsource: fixture\n\n${sections.join('\n\n')}`,
    };
}

/**
 * A node's worth of documents: the realistic three, plus enough filler to reach
 * the sort of library size the budgets are written against.
 */
export const LIBRARY_DOCS: FixtureDoc[] = [
    ...FIXTURE_DOCS,
    ...Array.from({ length: 9 }, (_, i) => syntheticDoc(i + 1)),
];
