# LaTeX renderer showcase

This message exercises every supported delimiter and environment, plus a real classical proof. Inline math like $E = mc^2$ and $\pi \approx 3.14159$ is left untouched in normal Markdown flow — only **block** formulas are rendered as images.

## 1. Dollar-delimited blocks ($$ … $$)

Euler's identity, the most beautiful equation in mathematics:

$$
e^{i\pi} + 1 = 0
$$

The Gaussian density, normalized so its integral over the real line is one:

$$
f(x) \;=\; \frac{1}{\sigma\sqrt{2\pi}}\, \exp\!\left(-\frac{(x - \mu)^2}{2\sigma^2}\right)
$$

## 2. Bracket-delimited blocks (\[ … \])

The Cauchy–Schwarz inequality in an inner-product space:

\[
\bigl|\langle u, v\rangle\bigr|^{2} \;\le\; \langle u, u\rangle \cdot \langle v, v\rangle
\]

## 3. `equation` environment

The time-dependent Schrödinger equation:

\begin{equation}
i\hbar \, \frac{\partial}{\partial t}\,\Psi(\mathbf{r}, t) \;=\; \hat{H}\,\Psi(\mathbf{r}, t)
\end{equation}

## 4. `align` environment — a classical proof

**Theorem (Gauss).** $\displaystyle \int_{-\infty}^{\infty} e^{-x^{2}}\,dx = \sqrt{\pi}.$

*Proof.* Let $I = \int_{-\infty}^{\infty} e^{-x^{2}}\,dx$. Squaring and switching to polar coordinates $(x, y) = (r\cos\theta,\, r\sin\theta)$:

\begin{align}
I^{2}
&= \left(\int_{-\infty}^{\infty} e^{-x^{2}}\,dx\right)\!\left(\int_{-\infty}^{\infty} e^{-y^{2}}\,dy\right) \\
&= \int_{-\infty}^{\infty}\!\int_{-\infty}^{\infty} e^{-(x^{2}+y^{2})}\,dx\,dy \\
&= \int_{0}^{2\pi}\!\!\int_{0}^{\infty} e^{-r^{2}}\, r \,dr\,d\theta \\
&= 2\pi \cdot \left[-\tfrac{1}{2} e^{-r^{2}}\right]_{0}^{\infty} \\
&= \pi.
\end{align}

Taking the positive square root gives $I = \sqrt{\pi}$. $\blacksquare$

## 5. `gather` environment

Maxwell's equations in differential form, in vacuum:

\begin{gather}
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_{0}} \\
\nabla \cdot \mathbf{B} = 0 \\
\nabla \times \mathbf{E} = -\,\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} = \mu_{0}\mathbf{J} + \mu_{0}\varepsilon_{0}\,\frac{\partial \mathbf{E}}{\partial t}
\end{gather}

## 6. `multline` environment

A long expression that needs to break across lines:

\begin{multline}
(a + b + c + d)^{4} \;=\; a^{4} + 4a^{3}b + 4a^{3}c + 4a^{3}d + 6a^{2}b^{2} + 12a^{2}bc + 12a^{2}bd \\
+\, 6a^{2}c^{2} + 12a^{2}cd + 6a^{2}d^{2} + 4ab^{3} + 12ab^{2}c + 12ab^{2}d + 12abc^{2} \\
+\, 24abcd + 12abd^{2} + 4ac^{3} + 12ac^{2}d + 12acd^{2} + 4ad^{3} + b^{4} + \cdots + d^{4}
\end{multline}

## 7. Starred (unnumbered) variants

\begin{align*}
\sum_{k=0}^{n} \binom{n}{k} &= 2^{n} \\
\sum_{k=0}^{n} (-1)^{k}\binom{n}{k} &= 0 \\
\sum_{k=0}^{n} k\binom{n}{k} &= n \, 2^{n-1}
\end{align*}

---

End of showcase. Each block above was rendered as an image; inline math was kept as plain text.
