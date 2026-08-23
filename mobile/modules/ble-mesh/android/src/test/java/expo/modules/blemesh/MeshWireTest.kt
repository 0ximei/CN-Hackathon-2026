package expo.modules.blemesh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The segmenter, checked against the limit that actually bites.
 *
 * These are pure functions with no Android in them, which is the only reason
 * this file can exist — and the reason it should. The bug it exists to prevent
 * cost a whole debugging session: segments were sized from the ATT MTU alone,
 * giving 514 bytes, and Bluetooth caps an attribute value at 512 however large
 * the MTU grows. Every write and every notify of every multi-segment message
 * threw, while HELLO — one small segment — went through untouched. So the mesh
 * found its peers, linked, identified and beaconed perfectly, and never moved a
 * single byte of content.
 *
 * Nothing off-device could see it, and on-device it presented as a link that
 * dropped every few seconds. An assertion on the arithmetic is what makes it
 * impossible to reintroduce.
 */
class MeshWireTest {

    @Test
    fun `no segment can exceed the attribute ceiling, at any MTU`() {
        // Including MTUs above the ceiling, which is the case that broke: the
        // negotiated MTU says 517, the attribute limit still says 512.
        for (mtu in intArrayOf(23, 100, 185, 247, 512, 515, 517, 1024)) {
            val segments = Segmenter.split(ByteArray(20_000), mtu)
            val largest = segments.maxOf { it.size }
            assertTrue(
                "MTU $mtu produced a ${largest}B segment, over the ${MeshWire.GATT_MAX_ATTR_LEN}B limit",
                largest <= MeshWire.GATT_MAX_ATTR_LEN,
            )
            // And inside what this particular link negotiated.
            assertTrue("MTU $mtu produced a segment larger than the link allows",
                largest <= mtu - MeshWire.ATT_OVERHEAD)
        }
    }

    @Test
    fun `a full-MTU link uses every byte it is allowed and not one more`() {
        assertEquals(511, MeshWire.payloadCapacity(517))
        assertEquals(512, Segmenter.split(ByteArray(5000), 517).first().size)
    }

    @Test
    fun `a tiny MTU still makes progress`() {
        assertEquals(19, MeshWire.payloadCapacity(23))
        assertTrue(Segmenter.split(ByteArray(100), 23).isNotEmpty())
    }

    @Test
    fun `a message survives being cut up and put back together`() {
        val message = ByteArray(9_001) { (it * 31 and 0xff).toByte() }
        val reassembler = Reassembler()
        var out: ByteArray? = null
        for (segment in Segmenter.split(message, 517)) {
            out = reassembler.push(segment) { }
        }
        assertArrayEquals(message, out)
    }

    @Test
    fun `a message shorter than one segment is a single final segment`() {
        val hello = byteArrayOf(2, 0x42, 0x2a, 0xa6.toByte(), 0xdf.toByte())
        val segments = Segmenter.split(hello, 517)
        assertEquals(1, segments.size)
        assertEquals(1, segments[0][0].toInt() and 1) // final bit
        assertArrayEquals(hello, Reassembler().push(segments[0]) { })
    }

    @Test
    fun `a lost segment is detected rather than silently concatenated`() {
        val segments = Segmenter.split(ByteArray(3_000) { 7 }, 517)
        val reassembler = Reassembler()
        val errors = mutableListOf<String>()
        reassembler.push(segments[0]) { errors.add(it) }
        // segments[1] never arrives
        for (i in 2 until segments.size) reassembler.push(segments[i]) { errors.add(it) }
        assertTrue("a gap should be reported", errors.isNotEmpty())
    }

    @Test
    fun `an empty segment is ignored rather than crashing`() {
        assertNull(Reassembler().push(ByteArray(0)) { })
    }
}
