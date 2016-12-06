namespace pxt.usb {

    export class USBError extends Error {
        constructor(msg: string) {
            super(msg)
        }
    }

    // http://www.linux-usb.org/usb.ids
    export const enum VID {
        ATMEL = 0x03EB,
        ARDUINO = 0x2341,
        ADAFRUIT = 0x239A,
        NXP = 0x0d28, // aka Freescale, KL26 etc
    }


    export type USBEndpointType = "bulk" | "interrupt" | "isochronous";
    export type USBRequestType = "standard" | "class" | "vendor"
    export type USBRecipient = "device" | "interface" | "endpoint" | "other"
    export type USBTransferStatus = "ok" | "stall" | "babble";
    export type USBDirection = "in" | "out";

    export type BufferSource = Uint8Array;


    export interface USBConfiguration {
        configurationValue: number;
        configurationName: string;
        interfaces: USBInterface[];
    };

    export interface USBInterface {
        interfaceNumber: number;
        alternate: USBAlternateInterface;
        alternates: USBAlternateInterface[];
        claimed: boolean;
    };

    export interface USBAlternateInterface {
        alternateSetting: number;
        interfaceClass: number;
        interfaceSubclass: number;
        interfaceProtocol: number;
        interfaceName: string;
        endpoints: USBEndpoint[];
    };


    export interface USBEndpoint {
        endpointNumber: number;
        direction: USBDirection;
        type: USBEndpointType;
        packetSize: number;
    }

    export interface USBDevice {
        vendorId: number; // VID.*
        productId: number; // 589

        manufacturerName: string; // "Arduino"
        productName: string; // "Arduino Zero"
        serialNumber: string; // ""

        deviceClass: number; // 0xEF - misc
        deviceSubclass: number; // 2
        deviceProtocol: number; // 1

        deviceVersionMajor: number; // 0x42
        deviceVersionMinor: number; // 0x00
        deviceVersionSubminor: number; // 0x01
        usbVersionMajor: number; // 2
        usbVersionMinor: number; // 1
        usbVersionSubminor: number; // 0

        configurations: USBConfiguration[];

        opened: boolean;

        open(): Promise<void>;
        close(): Promise<void>;
        selectConfiguration(configurationValue: number): Promise<void>;
        claimInterface(interfaceNumber: number): Promise<void>;
        releaseInterface(interfaceNumber: number): Promise<void>;
        selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
        controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
        controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
        clearHalt(direction: USBDirection, endpointNumber: number): Promise<void>;
        transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
        transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
        isochronousTransferIn(endpointNumber: number, packetLengths: number[]): Promise<USBIsochronousInTransferResult>;
        isochronousTransferOut(endpointNumber: number, data: BufferSource, packetLengths: number[]): Promise<USBIsochronousOutTransferResult>;
        reset(): Promise<void>;
    }

    export class HID {
        altIface: USBAlternateInterface;
        epIn: USBEndpoint;
        epOut: USBEndpoint;

        constructor(public dev: USBDevice) {
        }

        error(msg: string) {
            throw new USBError(U.lf("USB error on device {0} ({1})", this.dev.productName, msg))
        }

        sendRawPacketAsync(pkt: Uint8Array) {
            Util.assert(pkt.length <= 64)
            return this.dev.transferOut(this.epOut.endpointNumber, pkt)
                .then(res => {
                    if (res.status != "ok")
                        this.error("USB OUT transfer failed")
                })
        }

        recvRawPacketAsync(): Promise<Uint8Array> {
            return this.dev.transferIn(this.epIn.endpointNumber, 64)
                .then(res => {
                    if (res.status != "ok")
                        this.error("USB IN transfer failed")
                    let arr = new Uint8Array(res.data.buffer)
                    if (arr.length == 0)
                        return this.recvRawPacketAsync()
                    return arr
                })
        }

        initAsync() {
            let dev = this.dev
            return dev.open()
                // assume one configuration; no one really does more
                .then(() => dev.selectConfiguration(1))
                .then(() => {
                    let isHID = (iface: USBInterface) =>
                        iface.alternates[0].interfaceClass == 0xff &&
                        iface.alternates[0].interfaceSubclass == 42 &&
                        iface.alternates[0].endpoints[0].type == "interrupt";
                    let hid = dev.configurations[0].interfaces.filter(isHID)[0]
                    if (!hid)
                        this.error("cannot find USB HID interface")
                    this.altIface = hid.alternates[0]
                    this.epIn = this.altIface.endpoints.filter(e => e.direction == "in")[0]
                    this.epOut = this.altIface.endpoints.filter(e => e.direction == "out")[0]
                    Util.assert(this.epIn.packetSize == 64);
                    Util.assert(this.epOut.packetSize == 64);
                    Util.assert(this.epIn.type == "interrupt");
                    Util.assert(this.epOut.type == "interrupt");
                    //console.log("USB-device", dev)
                    return dev.claimInterface(hid.interfaceNumber)
                })
        }
    }

    export interface USBControlTransferParameters {
        requestType: USBRequestType;
        recipient: USBRecipient;
        request: number;
        value: number;
        index: number;
    }

    export interface USBInTransferResult {
        data: { buffer: ArrayBuffer; };
        status: USBTransferStatus;
    }

    export interface USBOutTransferResult {
        bytesWritten: number;
        status: USBTransferStatus;
    }

    export interface USBIsochronousInTransferPacket {
        data: DataView;
        status: USBTransferStatus;
    }

    export interface USBIsochronousInTransferResult {
        data: DataView;
        packets: USBIsochronousInTransferPacket[];
    }

    export interface USBIsochronousOutTransferPacket {
        bytesWritten: number;
        status: USBTransferStatus;
    }

    export interface USBIsochronousOutTransferResult {
        packets: USBIsochronousOutTransferPacket[];
    }

    function requestDeviceAsync(): Promise<USBDevice> {
        return (navigator as any).usb.requestDevice({ filters: [] })
    }

    function hf2Async() {
        return requestDeviceAsync()
            .then(dev => {
                let d = new HF2(dev)
                return d.initAsync()
                    .then(() => d)
            })
    }

    let initPromise: Promise<HF2>
    export function initAsync() {
        if (!initPromise)
            initPromise = hf2Async()
        return initPromise
    }

    const HF2_FLAG_PKT_LAST = 0xC0
    const HF2_FLAG_PKT_BODY = 0x80
    const HF2_FLAG_SERIAL = 0x40
    const HF2_FLAG_MASK = 0xC0
    const HF2_FLAG_RESERVED = 0x00
    const HF2_SIZE_MASK = 63

    const HF2_CMD_INFO = 0x0001
    const HF2_CMD_RESET_INTO_APP = 0x0002
    const HF2_CMD_RESET_INTO_BOOTLOADER = 0x0003
    const HF2_CMD_WRITE_FLASH_PAGE = 0x0004
    const HF2_CMD_MEM_WRITE_WORDS = 0x0005
    const HF2_CMD_MEM_READ_WORDS = 0x0006
    const HF2_CMD_START_FLASH = 0x0007
    const HF2_CMD_BININFO = 0x0008
    const HF2_CMD_CHKSUM_PAGES = 0x0009

    const HF2_MODE_BOOTLOADER = 0x01
    const HF2_MODE_USERSPACE = 0x02

    const HF2_STATUS_OK = 0x00000000
    const HF2_STATUS_INVALID_CMD = 0x00000001
    const HF2_STATUS_WRONG_MODE = 0x00000002

    export function write32(buf: Uint8Array, pos: number, v: number) {
        buf[pos + 0] = (v >> 0) & 0xff;
        buf[pos + 1] = (v >> 8) & 0xff;
        buf[pos + 2] = (v >> 16) & 0xff;
        buf[pos + 3] = (v >> 24) & 0xff;
    }

    export function write16(buf: Uint8Array, pos: number, v: number) {
        buf[pos + 0] = (v >> 0) & 0xff;
        buf[pos + 1] = (v >> 8) & 0xff;
    }

    export function read32(buf: Uint8Array, pos: number) {
        return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 32)
    }

    export function read16(buf: Uint8Array, pos: number) {
        return buf[pos] | (buf[pos + 1] << 8)
    }

    export interface BootloaderInfo {
        Header: string;
        Parsed: {
            Version: string;
            Features: string;
        };
        VersionParsed: string;
        Model: string;
        BoardID: string;
        FlashSize: string;
    }

    export class HF2 extends HID {
        private cmdSeq = 0;
        constructor(d: USBDevice) {
            super(d)
        }

        private lock = new U.PromiseQueue();
        infoRaw: string;
        info: BootloaderInfo;
        pageSize: number;
        bootloaderMode = false;

        onSerial = (buf: Uint8Array) => { };

        talkAsync(cmd: number, data?: Uint8Array) {
            let len = 4
            if (data) len += data.length
            let pkt = new Uint8Array(len)
            write16(pkt, 0, cmd);
            write16(pkt, 2, ++this.cmdSeq);
            let saved = read32(pkt, 0)
            if (data)
                for (let i = 0; i < data.length; ++i)
                    pkt[i + 4] = data[i]
            return this.sendPacketAsync(pkt)
                .then(() => this.recvPacketAsync())
                .then(res => {
                    let st = read32(res, 0)
                    if ((st & 0x7fffffff) != saved)
                        this.error("out of sync")
                    if (st & 0x80000000)
                        this.error("invalid command")
                    return res.slice(4)
                })
        }

        sendPacketAsync(buf: Uint8Array) {
            return this.sendPacketCoreAsync(buf, false)
        }

        recvPacketAsync() {
            let frames: Uint8Array[] = []

            let loop = (): Promise<Uint8Array> =>
                this.recvRawPacketAsync()
                    .then(buf => {
                        let tp = buf[0] & HF2_FLAG_MASK
                        let len = buf[0] & 63
                        let frame = new Uint8Array(len)
                        for (let i = 0; i < len; ++i)
                            frame[i] = buf[i + 1]
                        if (tp == HF2_FLAG_SERIAL) {
                            this.onSerial(frame)
                            return loop()
                        }
                        frames.push(frame)
                        if (tp == HF2_FLAG_PKT_BODY) {
                            return loop()
                        } else {
                            U.assert(tp == HF2_FLAG_PKT_LAST)
                            let total = 0
                            for (let f of frames) total += f.length
                            let r = new Uint8Array(total)
                            let ptr = 0
                            for (let f of frames) {
                                for (let i = 0; i < f.length; ++i)
                                    r[ptr++] = f[i]
                            }
                            return Promise.resolve(r)
                        }
                    })

            return this.lock.enqueue("in", loop)
        }

        sendSerialAsync(buf: Uint8Array) {
            return this.sendPacketCoreAsync(buf, true)
        }

        private sendPacketCoreAsync(buf: Uint8Array, serial: boolean) {
            let frame = new Uint8Array(64)
            let loop = (pos: number): Promise<void> => {
                let len = buf.length - pos
                if (len <= 0) return Promise.resolve()
                if (len > 63) {
                    len = 63
                    frame[0] = HF2_FLAG_PKT_BODY;
                } else {
                    frame[0] = HF2_FLAG_PKT_LAST;
                }
                if (serial) frame[0] = HF2_FLAG_SERIAL;
                frame[0] |= len;
                for (let i = 0; i < len; ++i)
                    frame[i + 1] = buf[pos + i]
                return this.sendRawPacketAsync(frame)
                    .then(() => loop(pos + len))
            }
            return this.lock.enqueue("out", () => loop(0))
        }

        flashAsync(blocks: pxtc.UF2.Block[]) {
            U.assert(this.bootloaderMode)
            let loopAsync = (pos: number): Promise<void> => {
                if (pos >= blocks.length)
                    return Promise.resolve()
                let b = blocks[pos]
                U.assert(b.payloadSize == this.pageSize)
                let buf = new Uint8Array(4 + b.payloadSize)
                write32(buf, 0, b.targetAddr)
                U.memcpy(buf, 4, b.data, 0, b.payloadSize)
                return this.talkAsync(HF2_CMD_WRITE_FLASH_PAGE, buf)
                    .then(() => loopAsync(pos + 1))
            }
            return loopAsync(0)
                .then(() =>
                    this.talkAsync(HF2_CMD_RESET_INTO_APP)
                        .catch(e => { }))
                .then(() => {
                    initPromise = null
                })
        }

        initAsync() {
            return super.initAsync()
                .then(() => this.talkAsync(HF2_CMD_INFO))
                .then(buf => {
                    this.infoRaw = U.fromUTF8(U.uint8ArrayToString(buf));
                    let info = {} as any
                    ("Header: " + this.infoRaw).replace(/^([\w\-]+):\s*([^\n\r]*)/mg,
                        (f, n, v) => {
                            info[n.replace(/-/g, "")] = v
                            return ""
                        })
                    this.info = info
                    let m = /v(\d\S+)\s+(\S+)/.exec(this.info.Header)
                    this.info.Parsed = {
                        Version: m[1],
                        Features: m[2],
                    }
                    console.log("Device connected", this.info)
                    return this.talkAsync(HF2_CMD_BININFO)
                })
                .then(binfo => {
                    this.bootloaderMode = binfo[0] == 1;
                    this.pageSize = read32(binfo, 4)
                })
        }

    }
}
