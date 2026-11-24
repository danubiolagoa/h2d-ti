import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acceptInvite, getInvite, meQuery } from "@/lib/auth";
import { homeFor } from "@/lib/navigation";

/** Mesma regra da API: 6 ou mais caracteres, com letras e números. */
export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < 6) return "A senha precisa ter ao menos 6 caracteres.";
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return "A senha precisa ter letras e números.";
  if (password !== confirmation) return "As senhas não são iguais.";
  return null;
}

export function SetPasswordPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search: { token?: unknown } = useSearch({ strict: false });
  const token = typeof search.token === "string" ? search.token : "";
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => getInvite(token),
    enabled: token !== "",
    retry: false,
    staleTime: Infinity,
  });
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const problem = passwordProblem(password, String(form.get("confirmation") ?? ""));
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await acceptInvite(token, password);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    queryClient.setQueryData(meQuery.queryKey, result.user);
    await navigate({ to: homeFor(result.user.role) });
  }

  const invalid = token === "" || (!invite.isPending && !invite.data);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <Logo className="mb-8" />
        {invite.isPending && token !== "" ? (
          <p className="text-muted">Conferindo o link…</p>
        ) : invalid ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Link inválido ou vencido</h1>
            <p role="alert" className="mt-2 text-muted">
              Peça um novo link ao administrador do sistema.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Defina sua senha</h1>
            <p className="mt-1 mb-6 wrap-anywhere text-muted">
              Olá, {invite.data?.name}. Escolha a senha para entrar com {invite.data?.email}.
            </p>
            <form onSubmit={submit} noValidate className="space-y-4">
              {error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger"
                >
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {error}
                </p>
              )}
              <div>
                <label htmlFor="password" className="mb-1.5 block font-medium">
                  Nova senha
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    className="pr-11"
                    autoFocus
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-muted hover:text-text"
                  >
                    {showPassword ? (
                      <EyeOff aria-hidden className="size-[18px]" />
                    ) : (
                      <Eye aria-hidden className="size-[18px]" />
                    )}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-muted">Mínimo de 6 caracteres, com letras e números.</p>
              </div>
              <div>
                <label htmlFor="confirmation" className="mb-1.5 block font-medium">
                  Repita a senha
                </label>
                <Input
                  id="confirmation"
                  name="confirmation"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" variant="primary" disabled={busy} className="w-full">
                {busy && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
                {busy ? "Salvando..." : "Definir senha e entrar"}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
