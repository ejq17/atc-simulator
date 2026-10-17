// Read or set the output volume of ONE named audio device without changing the system's default output.
// Used by e2e/realmic.spec.ts so the laptop speakers can play the test clip while the user's Bluetooth headphones
// (the default output) are left alone. macOS only.
//   swiftc -O scripts/output-volume.swift -o .cache/output-volume
//   .cache/output-volume list
//   .cache/output-volume get "MacBook Air Speakers"     -> "0.50 muted=0"
//   .cache/output-volume set "MacBook Air Speakers" 0.6 -> sets volume (and unmutes)
//   .cache/output-volume restore "MacBook Air Speakers" 0.5 1   -> volume, muted
import CoreAudio
import Foundation

func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ el: UInt32 = 0) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: el)
}

func allDevices() -> [AudioDeviceID] {
  var a = addr(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
  return ids
}

func name(_ id: AudioDeviceID) -> String {
  var a = addr(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal)
  var cf: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  AudioObjectGetPropertyData(id, &a, 0, nil, &size, &cf)
  return (cf?.takeRetainedValue() as String?) ?? ""
}

func hasOutput(_ id: AudioDeviceID) -> Bool {
  var a = addr(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size)
  return size > 0
}

func elements(_ id: AudioDeviceID) -> [UInt32] {
  var m = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, 0)
  if AudioObjectHasProperty(id, &m) { return [0] }
  return [1, 2].filter { var c = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, $0); return AudioObjectHasProperty(id, &c) }
}

func getVolume(_ id: AudioDeviceID) -> Float32 {
  var total: Float32 = 0
  let els = elements(id)
  for e in els {
    var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, e)
    var v: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v)
    total += v
  }
  return els.isEmpty ? -1 : total / Float32(els.count)
}

func setVolume(_ id: AudioDeviceID, _ value: Float32) {
  for e in elements(id) {
    var a = addr(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, e)
    var v = value
    AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
  }
}

func getMute(_ id: AudioDeviceID) -> UInt32 {
  var a = addr(kAudioDevicePropertyMute, kAudioObjectPropertyScopeOutput, 0)
  guard AudioObjectHasProperty(id, &a) else { return 0 }
  var v: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v)
  return v
}

func setMute(_ id: AudioDeviceID, _ muted: UInt32) {
  var a = addr(kAudioDevicePropertyMute, kAudioObjectPropertyScopeOutput, 0)
  guard AudioObjectHasProperty(id, &a) else { return }
  var v = muted
  AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v)
}

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: list | get <name> | set <name> <0..1> | restore <name> <0..1> <muted>"); exit(2) }
let outputs = allDevices().filter(hasOutput)
if args[1] == "list" {
  for d in outputs { print("\(name(d))\t\(String(format: "%.2f", getVolume(d)))\tmuted=\(getMute(d))") }
  exit(0)
}
guard args.count >= 3, let dev = outputs.first(where: { name($0).localizedCaseInsensitiveContains(args[2]) }) else {
  FileHandle.standardError.write("no output device matching \(args.count >= 3 ? args[2] : "?")\n".data(using: .utf8)!)
  exit(1)
}
switch args[1] {
case "get": print(String(format: "%.3f muted=%d", getVolume(dev), getMute(dev)))
case "set":
  setVolume(dev, Float32(args[3]) ?? 0.5)
  setMute(dev, 0)
  print(String(format: "%.3f muted=%d", getVolume(dev), getMute(dev)))
case "restore":
  setVolume(dev, Float32(args[3]) ?? 0.5)
  setMute(dev, UInt32(args.count > 4 ? args[4] : "0") ?? 0)
  print(String(format: "%.3f muted=%d", getVolume(dev), getMute(dev)))
default: exit(2)
}
