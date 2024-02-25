import { Suspense } from 'react'
import { useData, useAction, css } from 'firebolt'

export function Profile() {
  return (
    <Suspense fallback={<div>...</div>}>
      <Content />
    </Suspense>
  )
}

function Content() {
  // const [auth, setAuth] = useCookie('auth')
  const data = useData(getUser)
  const user = data.read()
  return (
    <div
      css={css`
        color: red;
      `}
      onClick={() => data.invalidate()}
    >
      <div>{user.name}</div>
    </div>
  )
}

export async function getUser(req) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  // const user = req.getCookie('user')
  const user = { name: 'Jim' + Math.random() }
  return user
}
