// Demo mode only (no database or storage locally): plain sample frames in
// public/demo, so the gallery, lightbox and media grid can be checked locally.
// Never a real client's photo and never stock. Never used when DATABASE_URL
// is set.
export type DemoPhoto = { url: string; filename: string; width: number; height: number };

export const DEMO_PHOTOS: DemoPhoto[] = [
  { url: "/demo/frame-01.svg", filename: "Sample-01.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-02.svg", filename: "Sample-02.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-03.svg", filename: "Sample-03.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-04.svg", filename: "Sample-04.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-05.svg", filename: "Sample-05.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-06.svg", filename: "Sample-06.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-07.svg", filename: "Sample-07.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-08.svg", filename: "Sample-08.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-09.svg", filename: "Sample-09.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-10.svg", filename: "Sample-10.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-11.svg", filename: "Sample-11.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-12.svg", filename: "Sample-12.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-13.svg", filename: "Sample-13.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-14.svg", filename: "Sample-14.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-15.svg", filename: "Sample-15.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-16.svg", filename: "Sample-16.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-17.svg", filename: "Sample-17.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-18.svg", filename: "Sample-18.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-19.svg", filename: "Sample-19.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-20.svg", filename: "Sample-20.jpg", width: 1600, height: 1066 },
  { url: "/demo/frame-21.svg", filename: "Sample-21.jpg", width: 1066, height: 1600 },
  { url: "/demo/frame-22.svg", filename: "Sample-22.jpg", width: 1066, height: 1600 },
  { url: "/demo/frame-23.svg", filename: "Sample-23.jpg", width: 1066, height: 1600 },
  { url: "/demo/frame-24.svg", filename: "Sample-24.jpg", width: 1066, height: 1600 },
];
