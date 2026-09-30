# Visitor-approved screen observation (SDK 0.1.8)

`ConvincedClient.describeScreen()` in SDK `0.1.8` describes one frame that the host application has captured after the visitor approves tab sharing. The SDK does not start sharing or capture frames itself.

```ts
const { observation } = await client.describeScreen(imageDataUrl, { signal })
```

`imageDataUrl` must be a base64 JPEG or PNG data URL whose decoded image is at most 1 MiB. `signal` is an optional `AbortSignal`. The method uses the current signed Convinced session and returns `{ observation: string }`; image bytes are not retained in client state. A session must already exist, and an ended session cannot describe a frame.

The host should offer a visible browser permission control, verify that the visitor shared the intended tab, capture only when a request needs a visual observation, and stop the media track when sharing ends. A structured page/tool observation can still work when sharing is unavailable or declined. A screen observation is evidence about the captured frame, not authorization to act on the page; page actions still need registered tools and their normal authorization.
