import { Icons } from '@firebolt-dev/icons'

import { GlobalStyles } from '@/components/GlobalStyles'
import { Analytics } from '@/components/Analytics'

export default function Document({ children }) {
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <Analytics />
        <Icons />
        <link
          rel='preload'
          href='/roboto-flex.woff2'
          as='font'
          type='font/woff2'
          crossOrigin='true'
        />
        <link
          rel='preload'
          href='/roboto-mono.woff2'
          as='font'
          type='font/woff2'
          crossOrigin='true'
        />
        <GlobalStyles />
      </head>
      <body>{children}</body>
    </html>
  )
}
