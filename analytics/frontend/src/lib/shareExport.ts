import { toCanvas } from "html-to-image";
import { jsPDF } from "jspdf";

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function copyShareText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function downloadShareText(text: string, filename = "imessage-share.txt"): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

function backgroundOf(node: HTMLElement): string {
  return getComputedStyle(node).backgroundColor || "#ffffff";
}

export async function exportSharePng(container: HTMLElement, filename = "imessage-share.png"): Promise<void> {
  const canvas = await toCanvas(container, { pixelRatio: 2, backgroundColor: backgroundOf(container) });
  triggerDownload(canvas.toDataURL("image/png"), filename);
}

// Paginates a long capture into an A4 PDF. Page breaks prefer the boundary
// between top-level share blocks (each conversation/person/overview card) so
// a card is only ever split across pages when it's taller than a full page
// on its own.
export async function exportSharePdf(container: HTMLElement, filename = "imessage-share.pdf"): Promise<void> {
  const pixelRatio = 2;
  const canvas = await toCanvas(container, { pixelRatio, backgroundColor: backgroundOf(container) });

  const containerTop = container.getBoundingClientRect().top;
  const blockEls = Array.from(container.querySelectorAll<HTMLElement>('[data-share-block="true"]'));
  const blockRects = blockEls
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { top: (r.top - containerTop) * pixelRatio, height: r.height * pixelRatio };
    })
    .sort((a, b) => a.top - b.top);

  const pdf = new jsPDF({ unit: "px", format: "a4", compress: true });
  const pageWidthPt = pdf.internal.pageSize.getWidth();
  const pageHeightPt = pdf.internal.pageSize.getHeight();
  const scale = pageWidthPt / canvas.width;
  const pageHeightPx = pageHeightPt / scale;

  const pageStarts = [0];
  let cursor = 0;
  for (const rect of blockRects) {
    const blockBottom = rect.top + rect.height;
    if (rect.height > pageHeightPx) {
      if (rect.top > cursor) {
        pageStarts.push(rect.top);
        cursor = rect.top;
      }
      let sliceStart = rect.top;
      while (sliceStart + pageHeightPx < blockBottom) {
        sliceStart += pageHeightPx;
        pageStarts.push(sliceStart);
      }
      cursor = sliceStart;
    } else if (blockBottom - cursor > pageHeightPx) {
      pageStarts.push(rect.top);
      cursor = rect.top;
    }
  }

  const boundaries = [...new Set(pageStarts)].sort((a, b) => a - b).filter((b) => b < canvas.height);
  boundaries.push(canvas.height);

  for (let i = 0; i < boundaries.length - 1; i++) {
    const sliceTop = boundaries[i];
    const sliceHeight = boundaries[i + 1] - sliceTop;
    if (sliceHeight <= 0) continue;

    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;
    const ctx = pageCanvas.getContext("2d")!;
    ctx.drawImage(canvas, 0, sliceTop, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

    if (i > 0) pdf.addPage();
    pdf.addImage(pageCanvas.toDataURL("image/png"), "PNG", 0, 0, pageWidthPt, sliceHeight * scale);
  }

  pdf.save(filename);
}
