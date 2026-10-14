export const multilineDollarMath = String.raw`于是

$$I=\int_0^{\pi/2}\frac{dt}{1+\tan t}
=\int_0^\infty \frac{du}{(1+u)(1+u^2)}.$$

到这里就变成有理函数积分了。部分分式：

$$\frac{1}{(1+u)(1+u^2)}
=\frac12\left(\frac{1}{1+u}+\frac{1-u}{1+u^2}\right).$$

积分：

$$I=\frac12\left[
\ln(1+u)+\arctan u-\frac12\ln(1+u^2)
\right]_0^\infty
=\frac{\pi}{4}.$$

这条路上，$\sec^2t$ 和 $\cos^2t$ 是这样出现的：

$$dt=\frac{du}{\sec^2t}=\cos^2t\,du=\frac{du}{1+u^2}.$$

---

如果你坚持直接在 $t$ 上操作，真正能走通的是**分子分母同乘 $1-\tan t$**（不是 $1+\tan t$）：

$$I=\int_0^{\pi/2}\frac{1-\tan t}{1-\tan^2t}\,dt.$$

用

$$1-\tan^2t=\frac{\cos2t}{\cos^2t},$$

得到

$$I=\int_0^{\pi/2}\frac{\cos^2t-\sin t\cos t}{\cos2t}\,dt.$$

再用倍角公式

$$\cos^2t=\frac{1+\cos2t}{2},\qquad \sin t\cos t=\frac{\sin2t}{2},$$

会变成

$$I=\frac12\int_0^{\pi/2}\left(\sec2t+1-\tan2t\right)dt.$$

这条路也能算出 $\dfrac{\pi}{4}$，但中间在 $t=\dfrac{\pi}{4}$ 处会出现“假奇点”，不如上面的 $u=\tan t$ 稳。

**总结：同乘 $1+\tan t$ 不行；同乘 $1-\tan t$ 可以，但会绕；最顺的是令 $u=\tan t$。**`
