// Play a WAV/AIFF file on ONE named output device (like `afplay`, but not tied to the system default output).
// Used by e2e/realmic.spec.ts to speak the test clip through the laptop speakers while Bluetooth headphones stay the default.
//   swiftc -O scripts/play-on-device.swift -o .cache/play-on-device
//   .cache/play-on-device "MacBook Air Speakers" e2e/fixtures/takeoff-n723ej-lead.wav
import AVFoundation
import CoreAudio
import Foundation

func uid(forDeviceNamed needle: String) -> String? {
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
  for id in ids {
    var n = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cfName: Unmanaged<CFString>?
    var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    AudioObjectGetPropertyData(id, &n, 0, nil, &s, &cfName)
    let name = (cfName?.takeRetainedValue() as String?) ?? ""
    var out = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var outSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(id, &out, 0, nil, &outSize)
    guard outSize > 0, name.localizedCaseInsensitiveContains(needle) else { continue }
    var u = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cfUid: Unmanaged<CFString>?
    var us = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    AudioObjectGetPropertyData(id, &u, 0, nil, &us, &cfUid)
    return cfUid?.takeRetainedValue() as String?
  }
  return nil
}

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write("usage: play-on-device <device name> <file>\n".data(using: .utf8)!); exit(2) }
guard let deviceUID = uid(forDeviceNamed: args[1]) else { FileHandle.standardError.write("no output device matching \(args[1])\n".data(using: .utf8)!); exit(1) }
do {
  let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: args[2]))
  player.currentDevice = deviceUID
  player.volume = 1
  guard player.prepareToPlay(), player.play() else { FileHandle.standardError.write("could not start playback\n".data(using: .utf8)!); exit(1) }
  while player.isPlaying { Thread.sleep(forTimeInterval: 0.05) }
  print(String(format: "played %.2f s on %@", player.duration, args[1]))
} catch {
  FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
  exit(1)
}
