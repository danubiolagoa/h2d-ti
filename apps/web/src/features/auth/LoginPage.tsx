import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
  MessagesSquare,
  Route,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login, meQuery } from "@/lib/auth";
import { homeFor, safeRedirect } from "@/lib/navigation";

const schema = z.object({
  email: z.email("Informe um e-mail válido"),
  password: z.string().min(1, "Informe a senha"),
});

type LoginForm = z.infer<typeof schema>;

const ERROR_MESSAGES = {
  credentials: "E-mail ou senha inválidos.",
  server: "Não foi possível conectar. Tente novamente em instantes.",
};

const HIGHLIGHTS = [
  {
    icon: MessagesSquare,
    title: "Resposta na hora",
    text: "O assistente consulta os manuais e cita a fonte.",
  },
  {
    icon: Route,
    title: "Chamado no lugar certo",
    text: "Classificado e atribuído ao técnico com a habilidade certa.",
  },
  {
    icon: ShieldCheck,
    title: "Gestão com SLA",
    text: "Prioridades, prazos e indicadores em um só sistema.",
  },
];

function BrandPanel() {
  return (
    <aside className="hidden w-[44%] max-w-[640px] flex-col justify-between gap-8 bg-sidebar p-12 text-sidebar-text lg:flex">
      <div className="text-white">
        <Logo subtitle />
      </div>
      <div>
        <h2 className="max-w-md text-3xl font-semibold tracking-tight text-white">
          A central de TI da sua empresa, do primeiro contato à solução.
        </h2>
        <ul className="mt-10 space-y-6">
          {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-4">
              <span
                aria-hidden
                className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sidebar-hover text-sidebar-accent"
              >
                <Icon className="size-5" />
              </span>
              <span>
                <span className="block font-medium text-white">{title}</span>
                <span className="block text-sidebar-muted">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-sidebar-muted">H2D TI</p>
    </aside>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search: { redirect?: unknown } = useSearch({ strict: false });
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(schema) });

  async function onSubmit(values: LoginForm) {
    setError(null);
    const result = await login(values.email, values.password);
    if (!result.ok) {
      setError(ERROR_MESSAGES[result.reason]);
      return;
    }
    queryClient.setQueryData(meQuery.queryKey, result.user);
    await navigate({ to: safeRedirect(search.redirect) ?? homeFor(result.user.role) });
  }

  return (
    <div className="flex min-h-dvh">
      <BrandPanel />
      <main className="relative flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">
          <Logo className="mb-8 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>
          <p className="mt-1 mb-6 text-muted">Acesse com seu e-mail corporativo.</p>

          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
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
              <label htmlFor="email" className="mb-1.5 block font-medium">
                E-mail
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="voce@empresa.com"
                autoFocus
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? "email-error" : undefined}
                {...register("email")}
              />
              {errors.email && (
                <p id="email-error" className="mt-1.5 text-xs text-danger">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block font-medium">
                Senha
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  className="pr-11"
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? "password-error" : undefined}
                  {...register("password")}
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
              {errors.password && (
                <p id="password-error" className="mt-1.5 text-xs text-danger">
                  {errors.password.message}
                </p>
              )}
            </div>

            <Button type="submit" variant="primary" disabled={isSubmitting} className="w-full">
              {isSubmitting && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
              {isSubmitting ? "Entrando..." : "Entrar"}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
