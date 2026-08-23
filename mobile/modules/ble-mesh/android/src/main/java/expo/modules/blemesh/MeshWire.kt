package expo.modules.blemesh

import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * The BLE-specific half of the wire format.
 *
 * MeshNet packets are defined in TypeScript (`src/protocol/packet.ts`) and are
 * radio-agnostic. This file covers only what a GATT link adds underneath them:
 * which UUIDs identify a mesh node, and how a packet too large for one ATT
 * write is cut up and put back together.
 */
object MeshWire {
  /** Advertised so nodes can find each other without pairing or a name match. */
  val SERVICE: UUID = UUID.fromString("7b2f0a10-9c4e-4b8a-9f3d-2a1c5e6d7f80")

  /** Peer -> us. Centrals write here; we are the GATT server. */
  val RX: UUID = UUID.fromString("7b2f0a11-9c4e-4b8a-9f3d-2a1c5e6d7f80")

  /** Us -> peer. We notify; subscribed centrals receive. */
  val TX: UUID = UUID.fromString("7b2f0a12-9c4e-4b8a-9f3d-2a1c5e6d7f80")

  /** Client Characteristic Configuration, the standard notify switch. */
  val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

  /** 0xFFFF is the "not registered with the Bluetooth SIG" id, correct here. */
  const val MANUFACTURER_ID = 0xFFFF

  /**
   * First byte of every reassembled message.
   *
   * A link has to carry one thing that is not a mesh packet: each end's 32-bit
   * node id. The advertisement carries it too, but only the scanning side sees
   * an advertisement — the node that gets connected *to* never does, and it
   * still has to know who is on the other end of the socket. One byte of
   * namespace keeps that handshake from being mistaken for a packet.
   */
  const val KIND_FRAME: Byte = 0x01
  const val KIND_HELLO: Byte = 0x02

  /** Refuse to buffer more than this while reassembling. */
  const val MAX_MESSAGE_BYTES = 96 * 1024

  /** ATT protocol overhead: 1 opcode byte + 2 handle bytes. */
  const val ATT_OVERHEAD = 3

  /** Our own 1-byte segmentation header. */
  const val SEGMENT_HEADER = 1

  /** Every stack supports 23; anything less is a broken negotiation. */
  const val MIN_MTU = 23

  /**
   * The ceiling on a single attribute value, which is not the ceiling on the MTU.
   *
   * Bluetooth caps an attribute value at 512 octets no matter how large the ATT
   * MTU grows, and Android enforces it: `writeCharacteristic` and
   * `notifyCharacteristicChanged` both throw `IllegalArgumentException` above
   * it rather than returning a status. Sizing segments from the MTU alone gives
   * 517 - 3 - 1 = 513 bytes of payload and a 514-byte value, two over, so
   * *every* segment of *every* multi-segment message throws — while a HELLO,
   * which fits in one small segment, sails through.
   *
   * That is the shape of the bug this constant exists to prevent: peers find
   * each other, link, identify and beacon perfectly, and not one byte of
   * content ever crosses.
   */
  const val GATT_MAX_ATTR_LEN = 512

  fun payloadCapacity(mtu: Int): Int {
    val usable = minOf(mtu.coerceAtLeast(MIN_MTU) - ATT_OVERHEAD, GATT_MAX_ATTR_LEN)
    return (usable - SEGMENT_HEADER).coerceAtLeast(1)
  }
}

/**
 * Cuts a message into ATT-sized segments.
 *
 * Header is one byte: `seq(7) << 1 | final(1)`. The sequence number is not
 * needed for ordering — a GATT connection delivers writes and notifications in
 * order — it exists so that a truncated or interleaved message is *detected*
 * rather than silently concatenated into the next one. Without it a single
 * dropped segment corrupts every message that follows on that link.
 */
object Segmenter {
  fun split(message: ByteArray, mtu: Int): List<ByteArray> {
    val capacity = MeshWire.payloadCapacity(mtu)
    val out = ArrayList<ByteArray>((message.size / capacity) + 1)
    var offset = 0
    var seq = 0
    do {
      val take = minOf(capacity, message.size - offset)
      val isFinal = offset + take >= message.size
      val seg = ByteArray(take + 1)
      seg[0] = (((seq and 0x7f) shl 1) or (if (isFinal) 1 else 0)).toByte()
      System.arraycopy(message, offset, seg, 1, take)
      out.add(seg)
      offset += take
      seq++
    } while (offset < message.size)
    return out
  }
}

/** One per link *direction*. Two links must never share an instance. */
class Reassembler {
  private val buffer = ByteArrayOutputStream()
  private var expectedSeq = 0

  /** Returns a complete message, or null while segments are outstanding. */
  fun push(segment: ByteArray, onError: (String) -> Unit): ByteArray? {
    if (segment.isEmpty()) return null
    val header = segment[0].toInt() and 0xff
    val seq = (header shr 1) and 0x7f
    val isFinal = (header and 1) == 1

    if (seq != expectedSeq) {
      onError("segment out of order: got $seq expected $expectedSeq, dropping ${buffer.size()}B")
      reset()
      // A first segment of a fresh message is still usable; anything else is
      // part of a message whose head we already lost.
      if (seq != 0) return null
    }

    if (buffer.size() + segment.size - 1 > MeshWire.MAX_MESSAGE_BYTES) {
      onError("message exceeded ${MeshWire.MAX_MESSAGE_BYTES}B, dropping")
      reset()
      return null
    }

    buffer.write(segment, 1, segment.size - 1)
    if (!isFinal) {
      expectedSeq = (seq + 1) and 0x7f
      return null
    }
    val message = buffer.toByteArray()
    reset()
    return message
  }

  fun reset() {
    buffer.reset()
    expectedSeq = 0
  }
}
