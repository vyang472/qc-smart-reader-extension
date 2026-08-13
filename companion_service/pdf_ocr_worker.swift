#!/usr/bin/env swift

import AppKit
import Darwin
import Foundation
import PDFKit
import Vision

struct OCRPage: Codable {
    let page: Int
    let text: String
}

struct OCROutput: Codable {
    let engine: String
    let pages: [OCRPage]
}

func fail(_ message: String) -> Never {
    let line = "\(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    exit(1)
}

func pageImage(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }

    let longestSide = max(bounds.width, bounds.height)
    let scale = min(3.0, max(1.5, 3000.0 / longestSide))
    let size = NSSize(
        width: max(1.0, bounds.width * scale),
        height: max(1.0, bounds.height * scale)
    )
    let thumbnail = page.thumbnail(of: size, for: .mediaBox)
    var proposedRect = NSRect(origin: .zero, size: thumbnail.size)
    return thumbnail.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
}

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 11.0, *) {
        let preferred = ["zh-Hans", "zh-Hant", "en-US"]
        let supported = try request.supportedRecognitionLanguages()
        let selected = preferred.filter { supported.contains($0) }
        if !selected.isEmpty {
            request.recognitionLanguages = selected
        }
    }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let observations = (request.results ?? []).sorted { left, right in
        let verticalDifference = left.boundingBox.midY - right.boundingBox.midY
        if abs(verticalDifference) > 0.01 {
            return verticalDifference > 0
        }
        return left.boundingBox.minX < right.boundingBox.minX
    }
    return observations.compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

guard CommandLine.arguments.count == 2 else {
    fail("usage: pdf_ocr_worker.swift /absolute/path/to/document.pdf")
}

let inputPath = CommandLine.arguments[1]
let inputURL = URL(fileURLWithPath: inputPath)
guard inputURL.isFileURL else {
    fail("PDF OCR input must be a local file path")
}
guard let document = PDFDocument(url: inputURL) else {
    fail("PDFKit could not open the PDF")
}

var pages: [OCRPage] = []
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else {
        pages.append(OCRPage(page: index + 1, text: ""))
        continue
    }
    guard let image = pageImage(page) else {
        pages.append(OCRPage(page: index + 1, text: ""))
        continue
    }
    do {
        pages.append(OCRPage(page: index + 1, text: try recognize(image)))
    } catch {
        fail("Vision OCR failed on page \(index + 1): \(error.localizedDescription)")
    }
}

do {
    let data = try JSONEncoder().encode(
        OCROutput(engine: "macos-pdfkit-vision", pages: pages)
    )
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
} catch {
    fail("failed to encode OCR output: \(error.localizedDescription)")
}
