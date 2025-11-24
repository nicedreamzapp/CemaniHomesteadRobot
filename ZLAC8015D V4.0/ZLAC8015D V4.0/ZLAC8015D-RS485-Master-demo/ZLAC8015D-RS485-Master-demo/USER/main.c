
#include "main.h" 

u8 key_push   = 0;

uint16_t MB_REG_ADDR1;
int16_t leftspeedwr16 = 0,rightspeedwr16 = 0;
uint16_t leftacc16 = 0,leftdec16 = 0,rightacc16 = 0,rightdec16 = 0;
uint8_t speedref[4],acc_dec[16];
void RCC_Configuration(void)  
{  
    RCC_DeInit();//将外设 RCC寄存器重设为缺省值  
  
    RCC_HSICmd(ENABLE);//使能HSI    
    while(RCC_GetFlagStatus(RCC_FLAG_HSIRDY) == RESET);//等待HSI使能成功  
    //加上这两句才能到64M
    
    RCC_HCLKConfig(RCC_SYSCLK_Div1);     
    RCC_PCLK1Config(RCC_HCLK_Div2);  
    RCC_PCLK2Config(RCC_HCLK_Div1);  
      
    //设置 PLL 时钟源及倍频系数  
    RCC_PLLConfig(RCC_PLLSource_HSI_Div2, RCC_PLLMul_2);//使能或者失能 PLL,这个参数可以取：ENABLE或者DISABLE   
    RCC_PLLCmd(ENABLE);//如果PLL被用于系统时钟,那么它不能被失能  
    //等待指定的 RCC 标志位设置成功 等待PLL初始化成功  
    while(RCC_GetFlagStatus(RCC_FLAG_PLLRDY) == RESET);  
  
    //设置系统时钟（SYSCLK） 设置PLL为系统时钟源  
    RCC_SYSCLKConfig(RCC_SYSCLKSource_PLLCLK);//选择想要的系统时钟   
    //等待PLL成功用作于系统时钟的时钟源  
    //  0x00：HSI 作为系统时钟   
    //  0x04：HSE作为系统时钟   
    //  0x08：PLL作为系统时钟    
    while(RCC_GetSYSCLKSource() != 0x08);//需与被选择的系统时钟对应起来，RCC_SYSCLKSource_PLL   
}  

 int main(void)
 {	 
//SystemInit();
  RCC_Configuration();
	delay_init();	    	 //延时函数初始化	  
	NVIC_Configuration(); 	 //设置NVIC中断分组2:2位抢占优先级，2位响应优先级
	USART2_Configuration();	 	//串口初始化为9600
//	TIM2_Configuration();
//  Key_Init();  		//Key_Init初始化 
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);
	delay_ms(1000);	 
	//初始化驱动器//
	MB_REG_ADDR1 = 0x200E;                                       //control bit
	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x0006); //clear alm
//	delay_ms(10);
//	MB_WriteHoldingReg_06H(MB_SLAVEADDR2, MB_REG_ADDR1, 0x0006);
	delay_ms(10);

  MB_REG_ADDR1 = 0x200E;
	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x0007);//stop
//	delay_ms(10);
//	MB_WriteHoldingReg_06H(MB_SLAVEADDR2, MB_REG_ADDR1, 0x0007);
	delay_ms(10);

  MB_REG_ADDR1 = 0x200D;                                      //mode
	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x0003);//speed mode
	delay_ms(10);

////	MB_WriteHoldingReg_06H(MB_SLAVEADDR2, MB_REG_ADDR1, 0x0003);
////	delay_ms(10);

	MB_REG_ADDR1 = 0x200E;
	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x0008);//start
	delay_ms(10);

////	MB_WriteHoldingReg_06H(MB_SLAVEADDR2, MB_REG_ADDR1, 0x0008);
////	delay_ms(10);

/*****************Acc_Dec*********************/
//	MB_REG_ADDR1 = 0x2080;
//	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x01f4);//left acc
//	delay_ms(10);

//	MB_REG_ADDR1 = 0x2081;
//	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x01f4);//left dec
//	delay_ms(10);

//	MB_REG_ADDR1 = 0x2082;
//	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x01f4);//right acc
//	delay_ms(10);

//	MB_REG_ADDR1 = 0x2083;
//	MB_WriteHoldingReg_06H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x01f4);//right dec
//	delay_ms(10);


	MB_REG_ADDR1 = 0x2080;//
	leftacc16    = 500;//500ms
	leftdec16    = 500;//500ms
	rightacc16    = 500;//500ms
	rightdec16    = 500;//500ms
	acc_dec[0]  = (uint8_t) leftacc16>>8;
	acc_dec[1]  = (uint8_t) leftacc16;
	acc_dec[2]  = (uint8_t) leftdec16>>8;
	acc_dec[3]  = (uint8_t) leftdec16;
	acc_dec[4]  = (uint8_t) rightacc16>>8;
	acc_dec[5]  = (uint8_t) rightacc16;
	acc_dec[6]  = (uint8_t) rightdec16>>8;
	acc_dec[7]  = (uint8_t) rightdec16;


	MB_WriteNumHoldingReg_10H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x0004,acc_dec);
	delay_ms(2);
/*****************Acc_Dec*********************/

  leftspeedwr16  = 50;//50rpm
  rightspeedwr16 = -50;//-50rpm	 
	while(1)
	{
			MB_REG_ADDR1 = 0x2088;
	    speedref[0]  = (uint8_t) leftspeedwr16>>8;
		  speedref[1]  = (uint8_t) leftspeedwr16;
	    speedref[2]  = (uint8_t) rightspeedwr16>>8;
		  speedref[3]  = (uint8_t) rightspeedwr16;
		
			MB_WriteNumHoldingReg_10H(MB_SLAVEADDR1, MB_REG_ADDR1, 0x0002,speedref);
			delay_ms(2);
//			MB_WriteHoldingReg_06H(MB_SLAVEADDR2, MB_REG_ADDR1, rightspeedwr16);
//			delay_ms(2);

      delay_ms(200);//循环时间		
  
	}
}

void TIM2_IRQHandler(void)
{ 
   if (TIM_GetITStatus(TIM2, TIM_IT_Update) != RESET)//判断是否发生TIM2更新中断
   {
		TIM_ClearITPendingBit(TIM2, TIM_IT_Update);//清除TIM2的中断待处理位
//    GPIO_SetBits(GPIOB,GPIO_Pin_2);						 //PB.5 输出高
			
		delay_ms(1);					
 //   GPIO_ResetBits(GPIOB,GPIO_Pin_2);						 //PB.5 输出高		
	}
}

