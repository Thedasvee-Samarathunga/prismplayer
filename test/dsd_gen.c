// Generates raw 1-bit sigma-delta streams (LSB first) for a test DSF: 2nd-order modulator.
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <stdint.h>
int main(int argc,char**argv){
  double fs=2822400.0; double secs=atof(argv[1]); long n=(long)(fs*secs); n-=n%(4096*8);
  double f[2]={1000.0,1500.0};
  for(int ch=0;ch<2;ch++){
    char name[64]; sprintf(name,"%s_%d.bin",argv[2],ch); FILE*o=fopen(name,"wb");
    double i1=0,i2=0,y=1; uint8_t byte=0; int bit=0;
    for(long k=0;k<n;k++){
      double x=0.4*sin(2*M_PI*f[ch]*k/fs);
      i1+=x-y; i2+=i1-y; y=(i2>=0)?1.0:-1.0;
      if(y>0) byte|=(1<<bit); // LSB first
      if(++bit==8){fputc(byte,o);byte=0;bit=0;}
    }
    fclose(o);
  }
  return 0;
}
