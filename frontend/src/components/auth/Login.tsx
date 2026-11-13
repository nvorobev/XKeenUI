import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { apiCall } from '@/lib/api'
import { showToast } from '@/lib/store'
import { IconEye, IconEyeOff, IconLock, IconUser } from '@tabler/icons-react'
import { useState } from 'react'

interface LoginFormProps {
  mode: 'login' | 'setup'
  onAuth: () => void
}

export function LoginForm({ mode, onAuth }: LoginFormProps) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const isSetup = mode === 'setup'

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!password) return
    setLoading(true)
    setError(null)
    try {
      const data = await apiCall<{ success: boolean; error?: string }>('POST', isSetup ? 'auth/setup' : 'auth/login', {
        username,
        password,
        remember,
      })
      if (data.success) {
        onAuth()
      } else {
        setError(data.error ?? (isSetup ? 'Не удалось установить пароль' : 'Неверный пароль'))
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Ошибка соединения'
      setError(message)
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="bg-background flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <p className="flex items-baseline gap-2 text-2xl tracking-[0.2em] select-none">
        <span className="text-primary font-black">XKEEN</span>
        <span className="text-foreground font-light">UI</span>
      </p>

      <section aria-labelledby="login-title" className="bg-card w-full max-w-sm rounded-lg border shadow-sm">
        <header className="border-b px-5 py-4">
          <h1 id="login-title" className="text-[15px] font-bold tracking-wider uppercase">
            {isSetup ? 'Создание пароля' : 'Вход в панель'}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            {isSetup ? 'Задайте пароль для доступа к панели управления' : 'Введите логин и пароль'}
          </p>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 px-5 py-5">
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="username">Логин</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <IconUser aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={loading || isSetup}
                  required
                  maxLength={32}
                />
              </InputGroup>
            </Field>
            <Field data-invalid={!!error || undefined}>
              <FieldLabel htmlFor="password">Пароль</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <IconLock aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="password"
                  type={visible ? 'text' : 'password'}
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setError(null)
                  }}
                  aria-invalid={!!error || undefined}
                  aria-describedby={error ? 'password-error' : undefined}
                  disabled={loading}
                  autoFocus
                  required
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => setVisible((v) => !v)}
                    aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
                    aria-pressed={visible}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {visible ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {error ? (
                <FieldError id="password-error">{error}</FieldError>
              ) : (
                isSetup && <FieldDescription>Пароль сохранится на роутере и понадобится при следующем входе</FieldDescription>
              )}
            </Field>

            {!isSetup && (
              <Field orientation="horizontal">
                <Checkbox id="remember" checked={remember} onCheckedChange={(v) => setRemember(!!v)} />
                <FieldLabel htmlFor="remember" className="font-normal">
                  Запомнить меня
                </FieldLabel>
              </Field>
            )}
          </FieldGroup>

          <Button type="submit" className="w-full" disabled={loading || !username.trim() || !password}>
            {loading && <Spinner data-icon="inline-start" />}
            {isSetup ? 'Установить пароль' : 'Войти'}
          </Button>
        </form>
      </section>
    </main>
  )
}
