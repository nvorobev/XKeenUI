import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { apiCall } from '@/lib/api'
import { useAppActions } from '@/lib/store'
import { useEffect, useRef, useState } from 'react'
import { Panel } from '../shell/Panel'

type User = { username: string; protected: boolean }
type UsersReply = { success: boolean; error?: string; users?: User[]; current_user?: string }

export function UsersPage() {
  const { showToast } = useAppActions()
  const [users, setUsers] = useState<User[]>([])
  const [currentUser, setCurrentUser] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<User | 'new' | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  async function load() {
    const reply = await apiCall<UsersReply>('GET', 'users')
    if (!reply.success || !reply.users) throw new Error(reply.error || 'Не удалось загрузить пользователей')
    setUsers(reply.users)
    setCurrentUser(reply.current_user ?? '')
  }

  useEffect(() => {
    let cancelled = false
    apiCall<UsersReply>('GET', 'users')
      .then((reply) => {
        if (cancelled) return
        if (!reply.success || !reply.users) throw new Error(reply.error || 'Не удалось загрузить пользователей')
        setUsers(reply.users)
        setCurrentUser(reply.current_user ?? '')
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function openEditor(user: User | 'new') {
    setEditor(user)
    setUsername(user === 'new' ? '' : user.username)
    setPassword('')
    setError('')
  }

  async function mutate(method: string, endpoint: string, body: unknown, relogin: boolean) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const reply = await apiCall<UsersReply>(method, endpoint, body, { timeoutMs: 30000 })
      if (!reply.success) throw new Error(reply.error || 'Не удалось сохранить пользователя')
      setEditor(null)
      setDeleting(null)
      showToast(method === 'DELETE' ? 'Пользователь удалён' : 'Пользователь сохранён')
      if (relogin) {
        window.dispatchEvent(new Event('auth-required'))
      } else {
        await load()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка запроса')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // Only admin manages accounts; other users may change just their own password.
  const isAdmin = currentUser === 'admin'
  const passwordOnly = editor !== null && editor !== 'new' && (editor.protected || !isAdmin)

  function save() {
    if (!editor) return
    const creating = editor === 'new'
    void mutate(
      creating ? 'POST' : 'PATCH',
      creating ? 'users' : `users/${encodeURIComponent(editor.username)}`,
      { ...(isAdmin ? { username: username.trim() } : {}), ...(password ? { password } : {}) },
      !creating && editor.username === currentUser
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-wider uppercase">Пользователи</h1>
          <p className="text-muted-foreground text-sm">
            {isAdmin
              ? 'Учётные записи для входа в панель. У admin можно изменить только пароль.'
              : 'Вы можете изменить свой пароль. Учётными записями управляет администратор (admin).'}
          </p>
        </div>
        {isAdmin && (
          <Button disabled={loading || busy || users.length >= 32} onClick={() => openEditor('new')}>
            Добавить пользователя
          </Button>
        )}
      </header>
      {error && !editor && !deleting && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Panel title="Пользователи панели" id="panel-users">
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          users.map((user) => (
            <div key={user.username} className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{user.username}</span>
                {user.protected && <Badge variant="secondary">По умолчанию</Badge>}
                {user.username === currentUser && <Badge variant="outline">Вы</Badge>}
              </div>
              <div className="flex gap-2">
                {(isAdmin || user.username === currentUser) && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => openEditor(user)}>
                    {user.protected || !isAdmin ? 'Изменить пароль' : 'Изменить'}
                  </Button>
                )}
                {isAdmin && !user.protected && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setError('')
                      setDeleting(user)
                    }}
                  >
                    Удалить
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </Panel>
      <Dialog
        open={!!editor}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editor === 'new' ? 'Новый пользователь' : 'Изменить пользователя'}</DialogTitle>
            <DialogDescription>
              {passwordOnly ? 'Логин изменить нельзя, только пароль.' : 'Логин и пароль для входа в панель.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="user-login">Логин</FieldLabel>
                <Input
                  id="user-login"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={busy || passwordOnly}
                  maxLength={32}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="user-password">{editor === 'new' ? 'Пароль' : 'Новый пароль'}</FieldLabel>
                <Input
                  id="user-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                  required={editor === 'new' || passwordOnly}
                />
              </Field>
            </FieldGroup>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setEditor(null)}>
                Отмена
              </Button>
              <Button type="submit" disabled={busy || !username.trim() || ((editor === 'new' || passwordOnly) && !password)}>
                {busy && <Spinner data-icon="inline-start" />}Сохранить
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить пользователя?</AlertDialogTitle>
            <AlertDialogDescription>
              Пользователь «{deleting?.username}» больше не сможет войти; его текущие сеансы завершатся.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (deleting)
                  void mutate('DELETE', `users/${encodeURIComponent(deleting.username)}`, undefined, deleting.username === currentUser)
              }}
            >
              {busy && <Spinner data-icon="inline-start" />}Удалить
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
