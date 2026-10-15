import AppKit
import Foundation
let output = CommandLine.arguments[1]
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 0.045, green: 0.045, blue: 0.065, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 210, yRadius: 210).fill()
let colors: [NSColor] = [.init(calibratedRed: 0.76, green: 0.57, blue: 1, alpha: 1),
    .init(calibratedRed: 0.93, green: 0.61, blue: 0.46, alpha: 1),
    .init(calibratedRed: 0.29, green: 0.84, blue: 0.75, alpha: 1)]
let points = [NSPoint(x: 290,y: 660), NSPoint(x: 734,y: 512), NSPoint(x: 290,y: 364)]
let line = NSBezierPath(); line.move(to: points[0]); line.curve(to: points[1], controlPoint1: NSPoint(x: 600,y: 660), controlPoint2: NSPoint(x: 734,y: 660)); line.curve(to: points[2], controlPoint1: NSPoint(x: 734,y: 364), controlPoint2: NSPoint(x: 600,y: 364));
NSColor(calibratedWhite: 0.8, alpha: 0.85).setStroke(); line.lineWidth = 30; line.lineCapStyle = .round; line.stroke()
for (index, point) in points.enumerated() {
    colors[index].setFill(); NSBezierPath(ovalIn: NSRect(x: point.x-90,y: point.y-90,width: 180,height: 180)).fill()
    NSColor(calibratedWhite: 0.05, alpha: 1).setFill(); NSBezierPath(ovalIn: NSRect(x: point.x-36,y: point.y-36,width: 72,height: 72)).fill()
}
image.unlockFocus()
let tiff = image.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
